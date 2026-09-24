import {mergeUsage, type UsageSummary} from '../simulate/usage.js'
import type {AnswerFinding} from '../simulate/source-fidelity.js'
import type {Tool} from '@modelcontextprotocol/sdk/types.js'

import type {McpClient} from '../mcp/client.js'
import {type HostIdentity, identityMeta, newSessionId, newSubjectId} from '../mcp/identity.js'
import {runHeadlessLoop} from '../simulate/headless-loop.js'
import type {SimulationProvider} from '../simulate/provider/index.js'
import type {ExecutionArtifacts} from './assertions.js'
import {type TestCase, type TestSuite, expectedTools, turnsOf} from './schema.js'
import type {AssertionResult, SuiteResult, TestCaseResult, TestOutcome} from './results.js'
import {evaluateAssertions} from './assertions.js'

/**
 * Run ONE turn through the shared loop and capture the artifacts needed for assertions.
 * `continueConversation` keeps prior turns in the provider's history (multi-turn cases).
 */
async function runTurn(
  provider: SimulationProvider,
  mcpClient: McpClient,
  tools: Tool[],
  message: string,
  continueConversation: boolean,
  callMeta?: Record<string, unknown>,
  onUsage?: (usage: UsageSummary) => void,
  onAnswerFindings?: (findings: AnswerFinding[]) => void,
): Promise<ExecutionArtifacts> {
  const {assistantResponse, trace, answerFindings} = await runHeadlessLoop({provider, mcpClient, tools, message, continueConversation, callMeta, onUsage})
  onAnswerFindings?.(answerFindings)

  const toolsCalled: string[] = []
  const toolArgs: Record<string, Record<string, unknown>> = {}
  for (const ev of trace) {
    toolsCalled.push(ev.toolName)
    toolArgs[ev.toolName] = ev.request ?? {}
  }

  return {
    toolsCalled,
    toolArgs,
    assistantResponse,
    trace,
  }
}

export interface EngineRunOptions {
  suite: TestSuite
  filePath: string
  /**
   * Factory that returns a fresh provider for each test case.
   * Each test case gets its own provider so message history doesn't leak between cases.
   */
  createProvider: () => SimulationProvider
  mcpClient: McpClient
  tools: Tool[]
  /** Base host identity for the run (null = send none). Cases/turns can override via `identity:`. */
  identity?: HostIdentity | null
  /** Repeat every case N times (fresh provider each run); outcome passes only if all runs pass. Default 1. */
  runs?: number
  /** Presentation observer; counts completed attempts, including failed attempts. */
  onProgress?: (progress: {completed: number; total: number; name: string}) => void
}

/**
 * Run an entire test suite sequentially, recording results for all cases.
 */
export async function runSuite(options: EngineRunOptions): Promise<SuiteResult> {
  const {suite, filePath, createProvider, mcpClient, tools, identity} = options
  const runs = Math.max(1, options.runs ?? 1)
  const suiteName = suite.suite ?? filePath
  const start = Date.now()
  const cases: TestCaseResult[] = []
  let completed = 0
  const total = suite.tests.length * runs

  for (let i = 0; i < suite.tests.length; i++) {
    const testCase = suite.tests[i]
    const name = testCase.name ?? `Test #${i + 1}`
    options.onProgress?.({completed, total, name})
    const opts = {index: i, name, testCase, createProvider, mcpClient, tools, identity: identity ?? null}
    const expected = [...new Set(turnsOf(testCase).flatMap((t) => expectedTools(t)))]
    if (runs === 1) {
      const r = await executeSingleCase(opts)
      cases.push({...r, class: testCase.class, expectedTools: expected})
      options.onProgress?.({completed: ++completed, total, name})
      continue
    }
    const results: TestCaseResult[] = []
    for (let n = 0; n < runs; n++) {
      results.push(await executeSingleCase(opts))
      options.onProgress?.({completed: ++completed, total, name})
    }
    const passed = results.filter((r) => r.outcome === 'pass').length
    const worst = results.find((r) => r.outcome === 'error') ?? results.find((r) => r.outcome === 'fail') ?? results[0]
    cases.push({
      ...worst,
      usage: mergeUsage(results.map(result => result.usage)),
      answerFindings: results.flatMap(result => result.answerFindings ?? []),
      outcome: results.every((r) => r.outcome === 'pass') ? 'pass' : worst.outcome,
      class: testCase.class,
      expectedTools: expected,
      runs: results.map((r) => ({outcome: r.outcome, toolsCalled: r.toolsCalled})),
      passRate: passed / runs,
    })
  }

  return {
    suiteName,
    usage: mergeUsage(cases.map(result => result.usage)),
    filePath,
    cases,
    durationMs: Date.now() - start,
  }
}

interface CaseRunOptions {
  index: number
  name: string
  testCase: TestCase
  createProvider: () => SimulationProvider
  mcpClient: McpClient
  tools: Tool[]
  identity: HostIdentity | null
}

/** Apply a case/turn `identity:` override to the base identity. */
function applyIdentity(base: HostIdentity | null, override: {subject?: string; session?: 'same' | 'new'; none?: true} | undefined, current: HostIdentity | null): HostIdentity | null {
  if (!override) return current
  if (override.none) return null
  let id: HostIdentity = current ?? base ?? {subject: newSubjectId(), session: newSessionId()}
  if (override.subject) id = {...id, subject: override.subject === 'new' ? newSubjectId() : override.subject}
  if (override.session === 'new') id = {...id, session: newSessionId()}
  return id
}

async function executeSingleCase(opts: CaseRunOptions): Promise<TestCaseResult> {
  const {index, name, testCase, createProvider, mcpClient, tools, identity: base} = opts
  const turns = turnsOf(testCase)
  // Each case is a new conversation for the same simulated user → fresh session id
  let identity: HostIdentity | null = base ? {...base, session: newSessionId()} : null
  const isMulti = turns.length > 1 || testCase.turns !== undefined
  const userMessage = turns.map((t) => t.user).join(' ⟶ ')

  const available = new Set(tools.map((tool) => tool.name))
  const missing = turns.flatMap((turn, i) => {
    // Only unconditional positive expectations are impossible before execution.
    // Negative assertions may name removed tools; a conditional claim can still
    // pass when the assistant makes no such claim, even if its tool is absent.
    const names = expectedTools(turn)
    return [...names].filter((tool) => !available.has(tool)).map((tool) => `turn ${i + 1}: ${tool}`)
  })
  if (missing.length) return {
    index, name, userMessage, outcome: 'error', assertions: [], toolsCalled: [], assistantResponse: '', turnCount: 0,
    errorMessage: `[tool-not-found] Test "${name}" references unavailable tools (${missing.join('; ')}). Available tools: ${[...available].sort().join(', ') || '(none)'}. Check the server URL and edit the expectation after reviewing \`ritmo mcp --list-tools\`.`,
  }
  const provider = createProvider()

  const assertionResults: AssertionResult[] = []
  const toolsCalled: string[] = []
  let assistantResponse = ''
  let usage = mergeUsage([])
  const answerFindings: AnswerFinding[] = []

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]
    identity = applyIdentity(base, turn.identity, identity)
    const meta = identityMeta(identity)
    let artifacts: ExecutionArtifacts
    try {
      const priorUsage = usage
      artifacts = await runTurn(provider, mcpClient, tools, turn.user, i > 0, Object.keys(meta).length ? meta : undefined, observed => {usage = mergeUsage([priorUsage, observed])}, findings => answerFindings.push(...findings))
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      return {
        index,
        name,
        userMessage,
        outcome: 'error',
        assertions: assertionResults,
        errorMessage: isMulti ? `turn ${i + 1}: ${errorMessage}` : errorMessage,
        toolsCalled,
        assistantResponse,
        turnCount: i + 1,
        usage,
        answerFindings,
      }
    }

    toolsCalled.push(...artifacts.toolsCalled)
    assistantResponse = artifacts.assistantResponse
    const results = evaluateAssertions(turn, artifacts)
    for (const r of results) {
      assertionResults.push(isMulti ? {...r, turn: i + 1} : r)
    }
  }

  const allPassed = assertionResults.every((a) => a.passed)
  const outcome: TestOutcome = assertionResults.length === 0
    ? 'pass'  // no assertions = trivially pass
    : allPassed ? 'pass' : 'fail'

  return {
    index,
    name,
    userMessage,
    outcome,
    assertions: assertionResults,
    toolsCalled,
    assistantResponse,
    turnCount: turns.length,
    usage,
    answerFindings,
  }
}
