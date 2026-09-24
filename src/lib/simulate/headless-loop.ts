import {type ModelUsage, type UsageSummary, summarizeUsage} from './usage.js'
import {type AnswerFinding, type SourceReference, sourceReferences, checkSourceLinks} from './source-fidelity.js'
import {McpError} from '../mcp/errors.js'
import type {Tool} from '@modelcontextprotocol/sdk/types.js'

import type {McpClient, ToolCallResult} from '../mcp/client.js'
import {checkResultContract} from '../validate/contract.js'
import {formatToolResultForModel} from './messages.js'
import type {SimulationProvider, ToolResult} from './provider/index.js'
import {type TraceEvent, addTraceEvent, createTrace} from './trace.js'

const MAX_LOOP_ITERATIONS = 20

export interface HeadlessLoopOptions {
  onUsage?: (usage: UsageSummary) => void
  signal?: AbortSignal
  /** Observe captured calls even if a later provider step fails or is cancelled. */
  onTrace?: (trace: TraceEvent[]) => void
  provider: SimulationProvider
  mcpClient: McpClient
  tools: Tool[]
  message: string
  /**
   * Called after every tool call with the full result (including widget-only
   * `_meta`). Used by the simulator to attach widgets / drive the bridge.
   */
  onToolResult?: (event: ToolCallEvent) => void | Promise<void>
  /**
   * When true and the provider already has history, append this message as a new
   * user turn instead of starting a fresh conversation.
   */
  continueConversation?: boolean
  /** `_meta` sent with every tools/call this turn (host identity, docs/apps-sdk-contract.md §5). */
  callMeta?: Record<string, unknown>
}

export interface ToolCallEvent {
  toolCallId: string
  name: string
  arguments: Record<string, unknown>
  result: ToolCallResult
}

export interface HeadlessLoopResult {
  usage: UsageSummary
  answerFindings: AnswerFinding[]
  assistantResponse: string
  trace: TraceEvent[]
}

export async function runHeadlessLoop(options: HeadlessLoopOptions): Promise<HeadlessLoopResult> {
  const {provider, mcpClient, tools, message, onToolResult, continueConversation, callMeta} = options
  const signal = options.signal
  const checkCancelled = () => {if (signal?.aborted) throw new McpError('cancelled', 'Simulation cancelled.')}
  const wait = async <T>(operation: Promise<T>): Promise<T> => {
    checkCancelled()
    if (!signal) return operation
    let abort: () => void = () => {}
    try {return await Promise.race([operation, new Promise<never>((_resolve,reject) => {abort=()=>reject(new McpError('cancelled','Simulation cancelled.'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort()})])}
    finally {signal.removeEventListener('abort',abort)}
  }
  checkCancelled()
  const trace = createTrace()
  const measurements: Array<ModelUsage | undefined> = []
  const sources = new Map<string, SourceReference>()
  const request = async (operation: () => ReturnType<SimulationProvider['sendInitial']>) => {
    checkCancelled()
    const index = measurements.push(undefined) - 1
    options.onUsage?.(summarizeUsage(measurements))
    const step = await wait(operation())
    measurements[index] = step.usage
    options.onUsage?.(summarizeUsage(measurements))
    return step
  }

  // First model call: continue an existing conversation when asked (and possible), else start fresh.
  const canContinue = continueConversation && provider.sendUserMessage && (provider.hasHistory ? provider.hasHistory() : true)
  let step = canContinue ? await request(() => provider.sendUserMessage!(message)) : await request(() => provider.sendInitial(message, tools))

  let iterations = 0
  while (step.toolCalls.length > 0 && iterations < MAX_LOOP_ITERATIONS) {
    iterations++

    const toolResults: ToolResult[] = []

    for (const tc of step.toolCalls) {
      checkCancelled()
      const start = Date.now()
      const startedAt = new Date(start).toISOString()
      try {
        const result = await wait(mcpClient.callTool(tc.name, tc.arguments, callMeta ? {meta: callMeta} : {}))
        checkCancelled()
        const latencyMs = Date.now() - start
        // Model sees content + structuredContent, never _meta (docs/apps-sdk-contract.md §4)
        const references = result.isError ? [] : sourceReferences(result)
        for (const source of references) sources.set(JSON.stringify(source), source)
        const forModel = formatToolResultForModel(result) + (references.length ? `

Source references from this result (null means no URL was provided):
${JSON.stringify(references)}` : '')
        const descriptor = tools.find((t) => t.name === tc.name)
        const contract = descriptor ? checkResultContract({name: tc.name, outputSchema: descriptor.outputSchema}, result) : undefined

        addTraceEvent(trace, {
          toolName: tc.name,
          status: result.isError ? 'error' : 'success',
          latencyMs,
          error: result.isError ? forModel : undefined,
          request: tc.arguments,
          requestMeta: callMeta,
          response: result,
          startedAt,
          contract: contract && contract.length > 0 ? contract : undefined,
        })

        options.onTrace?.([...trace])
        if (onToolResult) {
          await onToolResult({toolCallId: tc.id, name: tc.name, arguments: tc.arguments, result})
        }

        toolResults.push({
          toolCallId: tc.id,
          content: forModel,
        })
      } catch (err) {
        checkCancelled()
        const latencyMs = Date.now() - start
        const errorMsg = err instanceof Error ? err.message : String(err)

        addTraceEvent(trace, {
          toolName: tc.name,
          status: 'error',
          latencyMs,
          error: errorMsg,
          request: tc.arguments,
          requestMeta: callMeta,
          startedAt,
        })

        options.onTrace?.([...trace])
        // Feed error back to the model so it can handle it
        toolResults.push({
          toolCallId: tc.id,
          content: `Error: ${errorMsg}`,
        })
      }
    }

    // Continue the loop with tool results
    checkCancelled()
    step = await request(() => provider.sendToolResults(toolResults))
  }

  checkCancelled()
  return {
    assistantResponse: step.content ?? '(no response)',
    usage: summarizeUsage(measurements),
    answerFindings: checkSourceLinks(step.content ?? '', [...sources.values()]),
    trace,
  }
}
