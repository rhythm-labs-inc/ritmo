import {describe, expect, it, vi} from 'vitest'

import type {McpClient} from '../../src/lib/mcp/client.js'
import type {SimulationProvider, ProviderStepResult, ToolResult} from '../../src/lib/simulate/provider/index.js'
import {runSuite} from '../../src/lib/test-runner/engine.js'
import type {TestSuite} from '../../src/lib/test-runner/schema.js'

// Minimal mock MCP client
function makeMcpClient(toolResponse = 'tool result'): McpClient {
  return {
    callTool: vi.fn().mockResolvedValue({content: toolResponse, isError: false}),
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as McpClient
}

// Provider that returns a simple text response with no tool calls
function makeSimpleProvider(response = 'Hello!'): SimulationProvider {
  return {
    sendInitial: vi.fn().mockResolvedValue({content: response, toolCalls: []} as ProviderStepResult),
    sendToolResults: vi.fn().mockResolvedValue({content: response, toolCalls: []} as ProviderStepResult),
  }
}

// Provider that calls a tool on the first step then returns a response
function makeToolCallingProvider(toolName: string, toolArgs: Record<string, unknown>, finalResponse: string): SimulationProvider {
  let called = false
  return {
    sendInitial: vi.fn().mockImplementation(async () => {
      called = false
      return {
        content: null,
        toolCalls: [{id: 'tc1', name: toolName, arguments: toolArgs}],
      } as ProviderStepResult
    }),
    sendToolResults: vi.fn().mockImplementation(async (_results: ToolResult[]) => {
      if (!called) {
        called = true
        return {content: finalResponse, toolCalls: []} as ProviderStepResult
      }

      return {content: finalResponse, toolCalls: []} as ProviderStepResult
    }),
  }
}

function makeSuite(overrides: Partial<TestSuite> = {}): TestSuite {
  return {
    tests: [{user: 'test message'}],
    ...overrides,
  }
}

describe('runSuite — sequential execution', () => {
  it('reports completed attempts for repeats without changing their outcomes', async () => {
    const progress: number[] = []
    const result = await runSuite({suite: makeSuite({tests: [{user: 'first', assert_response_contains: 'missing'}, {user: 'second'}]}), filePath: 'progress.yaml', createProvider: () => makeSimpleProvider(), mcpClient: makeMcpClient(), tools: ['my_tool', 'nonexistent_tool', 'start', 'retune'].map((name) => ({name, inputSchema: {type: 'object' as const}})), runs: 2, onProgress: ({completed, total}) => { expect(total).toBe(4); progress.push(completed) }})
    expect(progress).toEqual([0, 1, 2, 2, 3, 4])
    expect(result.cases.map((c) => c.outcome)).toEqual(['fail', 'pass'])
  })
  it('runs all tests in declaration order', async () => {
    const order: number[] = []
    const suite = makeSuite({
      tests: [
        {user: 'first'},
        {user: 'second'},
        {user: 'third'},
      ],
    })

    let callIndex = 0
    const provider: SimulationProvider = {
      sendInitial: vi.fn().mockImplementation(async () => {
        order.push(callIndex++)
        return {content: 'ok', toolCalls: []}
      }),
      sendToolResults: vi.fn(),
    }

    await runSuite({
      suite,
      filePath: 'test.yaml',
      createProvider: () => provider,
      mcpClient: makeMcpClient(),
      tools: ['my_tool', 'nonexistent_tool', 'start', 'retune'].map((name) => ({name, inputSchema: {type: 'object' as const}})),
    })

    expect(order).toEqual([0, 1, 2])
  })

  it('continues through suite recording failures without stopping', async () => {
    const suite = makeSuite({
      tests: [
        {user: 'first', assert_response_contains: 'MISSING_TEXT'},
        {user: 'second', assert_response_contains: 'also missing'},
        {user: 'third'},
      ],
    })

    const result = await runSuite({
      suite,
      filePath: 'test.yaml',
      createProvider: () => makeSimpleProvider('hello world'),
      mcpClient: makeMcpClient(),
      tools: ['my_tool', 'nonexistent_tool', 'start', 'retune'].map((name) => ({name, inputSchema: {type: 'object' as const}})),
    })

    expect(result.cases).toHaveLength(3)
    expect(result.cases[0].outcome).toBe('fail')
    expect(result.cases[1].outcome).toBe('fail')
    expect(result.cases[2].outcome).toBe('pass')  // no assertions
  })

  it('creates a fresh provider for each test case', async () => {
    const providers: SimulationProvider[] = []
    const suite = makeSuite({tests: [{user: 'a'}, {user: 'b'}]})

    await runSuite({
      suite,
      filePath: 'test.yaml',
      createProvider: () => {
        const p = makeSimpleProvider('ok')
        providers.push(p)
        return p
      },
      mcpClient: makeMcpClient(),
      tools: ['my_tool', 'nonexistent_tool', 'start', 'retune'].map((name) => ({name, inputSchema: {type: 'object' as const}})),
    })

    expect(providers).toHaveLength(2)
    expect(providers[0]).not.toBe(providers[1])
  })
})

describe('runSuite — pass/fail outcomes', () => {
  it('marks test as pass when all assertions are satisfied', async () => {
    const suite = makeSuite({
      tests: [{
        user: 'hello',
        expect_tool: 'my_tool',
        assert_response_contains: 'result',
      }],
    })

    const result = await runSuite({
      suite,
      filePath: 'test.yaml',
      createProvider: () => makeToolCallingProvider('my_tool', {}, 'final result'),
      mcpClient: makeMcpClient('tool output'),
      tools: ['my_tool', 'nonexistent_tool', 'start', 'retune'].map((name) => ({name, inputSchema: {type: 'object' as const}})),
    })

    expect(result.cases[0].outcome).toBe('pass')
    expect(result.cases[0].toolsCalled).toContain('my_tool')
  })

  it('marks test as fail when an assertion fails', async () => {
    const suite = makeSuite({
      tests: [{user: 'hello', expect_tool: 'nonexistent_tool'}],
    })

    const result = await runSuite({
      suite,
      filePath: 'test.yaml',
      createProvider: () => makeSimpleProvider('I answered without tools'),
      mcpClient: makeMcpClient(),
      tools: ['my_tool', 'nonexistent_tool', 'start', 'retune'].map((name) => ({name, inputSchema: {type: 'object' as const}})),
    })

    expect(result.cases[0].outcome).toBe('fail')
    expect(result.cases[0].assertions[0].passed).toBe(false)
  })

  it('marks test as pass when there are no assertions', async () => {
    const suite = makeSuite({tests: [{user: 'hello'}]})

    const result = await runSuite({
      suite,
      filePath: 'test.yaml',
      createProvider: () => makeSimpleProvider('hi'),
      mcpClient: makeMcpClient(),
      tools: ['my_tool', 'nonexistent_tool', 'start', 'retune'].map((name) => ({name, inputSchema: {type: 'object' as const}})),
    })

    expect(result.cases[0].outcome).toBe('pass')
  })

  it('marks test as error when provider throws', async () => {
    const suite = makeSuite({tests: [{user: 'hello'}]})

    const provider: SimulationProvider = {
      sendInitial: vi.fn().mockRejectedValue(new Error('API rate limit exceeded')),
      sendToolResults: vi.fn(),
    }

    const result = await runSuite({
      suite,
      filePath: 'test.yaml',
      createProvider: () => provider,
      mcpClient: makeMcpClient(),
      tools: ['my_tool', 'nonexistent_tool', 'start', 'retune'].map((name) => ({name, inputSchema: {type: 'object' as const}})),
    })

    expect(result.cases[0].outcome).toBe('error')
    expect(result.cases[0].errorMessage).toContain('rate limit')
  })
})

describe('runSuite — tool call artifacts', () => {
  it('captures tool names called during the run', async () => {
    const suite = makeSuite({tests: [{user: 'fetch data'}]})

    const result = await runSuite({
      suite,
      filePath: 'test.yaml',
      createProvider: () => makeToolCallingProvider('fetch_data', {id: 42}, 'Done'),
      mcpClient: makeMcpClient(),
      tools: ['my_tool', 'nonexistent_tool', 'start', 'retune'].map((name) => ({name, inputSchema: {type: 'object' as const}})),
    })

    expect(result.cases[0].toolsCalled).toContain('fetch_data')
  })

  it('captures the assistant response in the result', async () => {
    const suite = makeSuite({tests: [{user: 'hello'}]})

    const result = await runSuite({
      suite,
      filePath: 'test.yaml',
      createProvider: () => makeSimpleProvider('This is the final response'),
      mcpClient: makeMcpClient(),
      tools: ['my_tool', 'nonexistent_tool', 'start', 'retune'].map((name) => ({name, inputSchema: {type: 'object' as const}})),
    })

    expect(result.cases[0].assistantResponse).toBe('This is the final response')
  })
})

describe('runSuite — multi-turn cases (RHY-65)', () => {
  /** A provider whose reply depends on the turn: turn 1 calls `start`, turn 2 calls `retune` only if history exists. */
  function makeMultiTurnProvider(): SimulationProvider & {history: string[]} {
    const history: string[] = []
    const step = (msg: string): ProviderStepResult => {
      history.push(msg)
      if (history.length === 1) return {content: null, toolCalls: [{id: 't1', name: 'start', arguments: {}}]}
      return {content: null, toolCalls: [{id: 't2', name: 'retune', arguments: {from: history[0]}}]}
    }
    return {
      history,
      sendInitial: vi.fn(async (m: string) => step(m)),
      sendUserMessage: vi.fn(async (m: string) => step(m)),
      hasHistory: () => history.length > 0,
      sendToolResults: vi.fn(async () => {
        return {content: `done ${history.length}`, toolCalls: []}
      }),
    }
  }

  it('runs turns on ONE provider via sendUserMessage, evaluates assertions per turn, tags results with turn numbers', async () => {
    const provider = makeMultiTurnProvider()
    const result = await runSuite({
      suite: makeSuite({tests: [{
        name: 'build then retune',
        turns: [
          {user: 'start a build', expect_tool: 'start'},
          {user: 'can we retune?', expect_tool: 'retune', assert_tool_param: {from: 'start a build'}},
        ],
        assert_response_contains: 'done 2',
      }]}),
      filePath: 'x.yaml',
      createProvider: () => provider,
      mcpClient: makeMcpClient(),
      tools: ['my_tool', 'nonexistent_tool', 'start', 'retune'].map((name) => ({name, inputSchema: {type: 'object' as const}})),
    })
    const tc = result.cases[0]
    expect(tc.outcome).toBe('pass')
    expect(tc.turnCount).toBe(2)
    expect(tc.userMessage).toBe('start a build ⟶ can we retune?')
    expect(tc.toolsCalled).toEqual(['start', 'retune'])
    expect((provider.sendInitial as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
    expect((provider.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
    expect(tc.assertions.map((a) => [a.type, a.turn, a.passed])).toEqual([
      ['expect_tool', 1, true],
      ['expect_tool', 2, true],
      ['assert_tool_param', 2, true],
      ['assert_response_contains', 2, true],
    ])
  })

  it('a failing turn fails the case and reports the turn', async () => {
    const result = await runSuite({
      suite: makeSuite({tests: [{turns: [{user: 'a', expect_tool: 'start'}, {user: 'b', expect_no_tool_call: true}]}]}),
      filePath: 'x.yaml',
      createProvider: () => makeMultiTurnProvider(),
      mcpClient: makeMcpClient(),
      tools: ['my_tool', 'nonexistent_tool', 'start', 'retune'].map((name) => ({name, inputSchema: {type: 'object' as const}})),
    })
    const tc = result.cases[0]
    expect(tc.outcome).toBe('fail')
    expect(tc.assertions.find((a) => !a.passed)?.turn).toBe(2)
  })

  it('a provider without sendUserMessage still works (each turn restarts the conversation)', async () => {
    const result = await runSuite({
      suite: makeSuite({tests: [{turns: [{user: 'a'}, {user: 'b'}]}]}),
      filePath: 'x.yaml',
      createProvider: () => makeSimpleProvider('ok'),
      mcpClient: makeMcpClient(),
      tools: ['my_tool', 'nonexistent_tool', 'start', 'retune'].map((name) => ({name, inputSchema: {type: 'object' as const}})),
    })
    expect(result.cases[0].outcome).toBe('pass')
    expect(result.cases[0].turnCount).toBe(2)
  })
})
