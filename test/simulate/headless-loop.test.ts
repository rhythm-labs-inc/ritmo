import {describe, expect, it, vi} from 'vitest'

import type {McpClient, ToolCallResult} from '../../src/lib/mcp/client.js'
import {runHeadlessLoop} from '../../src/lib/simulate/headless-loop.js'
import type {ProviderStepResult, SimulationProvider, ToolResult} from '../../src/lib/simulate/provider/index.js'

function makeProvider(steps: ProviderStepResult[]): SimulationProvider {
  let callIndex = 0
  return {
    sendInitial: vi.fn(async () => steps[callIndex++]!),
    sendToolResults: vi.fn(async () => steps[callIndex++]!),
  }
}

function makeMcpClient(results: Record<string, ToolCallResult>): McpClient {
  return {
    callTool: vi.fn(async (name: string) => {
      if (results[name]) return results[name]
      throw new Error(`Unknown tool: ${name}`)
    }),
  } as unknown as McpClient
}

describe('runHeadlessLoop', () => {
  it('returns assistant response with no tool calls', async () => {
    const provider = makeProvider([
      {content: 'Hello! How can I help?', toolCalls: []},
    ])
    const mcpClient = makeMcpClient({})

    const result = await runHeadlessLoop({
      provider,
      mcpClient,
      tools: [],
      message: 'Hi',
    })

    expect(result.assistantResponse).toBe('Hello! How can I help?')
    expect(result.trace).toHaveLength(0)
  })

  it('handles a single tool call round-trip', async () => {
    const provider = makeProvider([
      {
        content: null,
        toolCalls: [{id: 'tc1', name: 'get_weather', arguments: {location: 'NYC'}}],
      },
      {content: 'It is sunny in NYC.', toolCalls: []},
    ])
    const mcpClient = makeMcpClient({
      get_weather: {
        content: [{type: 'text', text: 'Sunny, 72°F'}],
        isError: false,
      },
    })

    const result = await runHeadlessLoop({
      provider,
      mcpClient,
      tools: [],
      message: 'Weather in NYC?',
    })

    expect(result.assistantResponse).toBe('It is sunny in NYC.')
    expect(result.trace).toHaveLength(1)
    expect(result.trace[0].toolName).toBe('get_weather')
    expect(result.trace[0].status).toBe('success')
  })

  it('handles multiple tool calls in one step', async () => {
    const provider = makeProvider([
      {
        content: null,
        toolCalls: [
          {id: 'tc1', name: 'tool_a', arguments: {}},
          {id: 'tc2', name: 'tool_b', arguments: {}},
        ],
      },
      {content: 'Done.', toolCalls: []},
    ])
    const mcpClient = makeMcpClient({
      tool_a: {content: 'result_a', isError: false},
      tool_b: {content: 'result_b', isError: false},
    })

    const result = await runHeadlessLoop({
      provider,
      mcpClient,
      tools: [],
      message: 'Do both',
    })

    expect(result.trace).toHaveLength(2)
    expect(result.trace[0].toolName).toBe('tool_a')
    expect(result.trace[1].toolName).toBe('tool_b')
    expect(result.assistantResponse).toBe('Done.')
  })

  it('handles multi-step tool call chains', async () => {
    const provider = makeProvider([
      {
        content: null,
        toolCalls: [{id: 'tc1', name: 'step1', arguments: {}}],
      },
      {
        content: null,
        toolCalls: [{id: 'tc2', name: 'step2', arguments: {}}],
      },
      {content: 'All done.', toolCalls: []},
    ])
    const mcpClient = makeMcpClient({
      step1: {content: 'r1', isError: false},
      step2: {content: 'r2', isError: false},
    })

    const result = await runHeadlessLoop({
      provider,
      mcpClient,
      tools: [],
      message: 'Multi-step',
    })

    expect(result.trace).toHaveLength(2)
    expect(result.assistantResponse).toBe('All done.')
  })

  it('records error trace when tool call throws', async () => {
    const provider = makeProvider([
      {
        content: null,
        toolCalls: [{id: 'tc1', name: 'fail_tool', arguments: {}}],
      },
      {content: 'Tool had an error.', toolCalls: []},
    ])
    const mcpClient = {
      callTool: vi.fn(async () => { throw new Error('Connection refused') }),
    } as unknown as McpClient

    const result = await runHeadlessLoop({
      provider,
      mcpClient,
      tools: [],
      message: 'Try this',
    })

    expect(result.trace).toHaveLength(1)
    expect(result.trace[0].status).toBe('error')
    expect(result.trace[0].error).toContain('Connection refused')
    // The loop continues — error is fed back to the model
    expect(result.assistantResponse).toBe('Tool had an error.')
  })

  it('records error trace when MCP reports isError', async () => {
    const provider = makeProvider([
      {
        content: null,
        toolCalls: [{id: 'tc1', name: 'err_tool', arguments: {}}],
      },
      {content: 'Handled.', toolCalls: []},
    ])
    const mcpClient = makeMcpClient({
      err_tool: {
        content: [{type: 'text', text: 'Not found'}],
        isError: true,
      },
    })

    const result = await runHeadlessLoop({
      provider,
      mcpClient,
      tools: [],
      message: 'err',
    })

    expect(result.trace).toHaveLength(1)
    expect(result.trace[0].status).toBe('error')
    expect(result.trace[0].error).toContain('Not found')
  })

  it('returns "(no response)" when provider returns null content', async () => {
    const provider = makeProvider([
      {content: null, toolCalls: []},
    ])
    const mcpClient = makeMcpClient({})

    const result = await runHeadlessLoop({
      provider,
      mcpClient,
      tools: [],
      message: 'silent',
    })

    expect(result.assistantResponse).toBe('(no response)')
  })

  it('feeds tool result content back to provider.sendToolResults', async () => {
    const sendToolResultsSpy = vi.fn(async (): Promise<ProviderStepResult> =>
      ({content: 'ok', toolCalls: []}),
    )
    const provider: SimulationProvider = {
      sendInitial: vi.fn(async () => ({
        content: null,
        toolCalls: [{id: 'tc1', name: 'my_tool', arguments: {q: 'hi'}}],
      })),
      sendToolResults: sendToolResultsSpy,
    }
    const mcpClient = makeMcpClient({
      my_tool: {
        content: [{type: 'text', text: 'tool output here'}],
        isError: false,
      },
    })

    await runHeadlessLoop({
      provider,
      mcpClient,
      tools: [],
      message: 'test',
    })

    expect(sendToolResultsSpy).toHaveBeenCalledWith([
      {toolCallId: 'tc1', content: 'tool output here'},
    ])
  })
})

describe('runHeadlessLoop — full tool results (RHY-62)', () => {
  it('feeds the model content + structuredContent but never _meta; captures full payloads in the trace; fires onToolResult', async () => {
    const provider = makeProvider([
      {content: null, toolCalls: [{id: 'tc1', name: 'build', arguments: {step: 1}}]},
      {content: 'done', toolCalls: []},
    ])
    const full: ToolCallResult = {
      content: [{type: 'text', text: 'Card 1 saved.'}],
      structuredContent: {phase: 'building', step: 1},
      _meta: {rhythmSessionToken: 'SECRET-TOKEN'},
      isError: false,
    }
    const mcpClient = makeMcpClient({build: full})
    const seen: unknown[] = []

    const result = await runHeadlessLoop({
      provider, mcpClient, tools: [], message: 'go',
      onToolResult: (ev) => { seen.push(ev) },
    })

    const sent = (provider.sendToolResults as ReturnType<typeof vi.fn>).mock.calls[0][0] as ToolResult[]
    expect(sent[0].content).toContain('Card 1 saved.')
    expect(sent[0].content).toContain('"phase":"building"')
    expect(sent[0].content).not.toContain('SECRET-TOKEN')

    expect(result.trace[0].request).toEqual({step: 1})
    expect(result.trace[0].response).toEqual(full)
    expect(result.trace[0].startedAt).toMatch(/^\d{4}-/)

    expect(seen).toHaveLength(1)
    expect((seen[0] as {result: ToolCallResult}).result._meta).toEqual({rhythmSessionToken: 'SECRET-TOKEN'})
    expect((seen[0] as {toolCallId: string}).toolCallId).toBe('tc1')
  })

  it('records the request but no response on a thrown call', async () => {
    const provider = makeProvider([
      {content: null, toolCalls: [{id: 'tc1', name: 'missing', arguments: {a: 1}}]},
      {content: 'recovered', toolCalls: []},
    ])
    const result = await runHeadlessLoop({provider, mcpClient: makeMcpClient({}), tools: [], message: 'x'})
    expect(result.trace[0].status).toBe('error')
    expect(result.trace[0].request).toEqual({a: 1})
    expect(result.trace[0].response).toBeUndefined()
  })
})

describe('runHeadlessLoop — continueConversation (RHY-65)', () => {
  it('uses sendUserMessage when asked and the provider has history; falls back to sendInitial otherwise', async () => {
    const provider: SimulationProvider = {
      sendInitial: vi.fn(async () => ({content: 'first', toolCalls: []})),
      sendUserMessage: vi.fn(async () => ({content: 'second', toolCalls: []})),
      sendToolResults: vi.fn(async () => ({content: '', toolCalls: []})),
      hasHistory: vi.fn(() => false),
    }
    const mcp = makeMcpClient({})
    // no history yet → sendInitial even with continueConversation
    let r = await runHeadlessLoop({provider, mcpClient: mcp, tools: [], message: 'a', continueConversation: true})
    expect(r.assistantResponse).toBe('first')
    ;(provider.hasHistory as ReturnType<typeof vi.fn>).mockReturnValue(true)
    r = await runHeadlessLoop({provider, mcpClient: mcp, tools: [], message: 'b', continueConversation: true})
    expect(r.assistantResponse).toBe('second')
    // explicit fresh start
    r = await runHeadlessLoop({provider, mcpClient: mcp, tools: [], message: 'c'})
    expect(r.assistantResponse).toBe('first')
  })
})
