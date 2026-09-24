import {describe, expect, it, vi} from 'vitest'
import {runSuite} from '../../src/lib/test-runner/engine.js'
import type {McpClient} from '../../src/lib/mcp/client.js'
import type {TestCase} from '../../src/lib/test-runner/schema.js'

describe('expected tool preflight', () => {
  it.each<TestCase>([
    {user: 'list', expect_tool: 'list_projects'},
    {user: 'list', tools_called: ['list_projects']},
    {turns: [{user: 'hello'}, {user: 'list', expect_tool: 'list_projects'}]},
  ])('rejects unavailable references before constructing a provider or executing any turn: %j', async (testCase) => {
    const createProvider = vi.fn()
    const callTool = vi.fn()
    const result = await runSuite({suite: {tests: [{...testCase, name: 'Projects'}]}, filePath: 'smoke.yaml', createProvider, mcpClient: {callTool} as unknown as McpClient, tools: [{name: 'list_apps', inputSchema: {type: 'object'}}]})
    expect(createProvider).not.toHaveBeenCalled()
    expect(callTool).not.toHaveBeenCalled()
    expect(result.cases[0].outcome).toBe('error')
    expect(result.cases[0].errorMessage).toMatch(/tool-not-found.*Projects.*list_projects.*list_apps/s)
  })
  it('allows absent forbidden tools and honors last-turn top-level overrides', async () => {
    const sendInitial = vi.fn().mockResolvedValue({content: 'hello', toolCalls: []})
    const result = await runSuite({suite: {tests: [{turns: [{user: 'hi', expect_tool: 'obsolete'}], tools_called: [], expect_tool: 'present', tools_not_called: ['absent']}]}, filePath: 'smoke.yaml', createProvider: () => ({sendInitial, sendToolResults: vi.fn()}), mcpClient: {} as McpClient, tools: [{name: 'present', inputSchema: {type: 'object'}}]})
    expect(sendInitial).toHaveBeenCalledOnce()
    expect(result.cases[0].outcome).toBe('fail')
  })
})

it('preserves conditional claim guards for unavailable tools', async () => {
  const sendInitial = vi.fn().mockResolvedValueOnce({content: 'No action taken', toolCalls: []}).mockResolvedValueOnce({content: 'I deleted it', toolCalls: []})
  const testCase = {user: 'inspect', tools_not_called: ['removed'], no_claim_without_call: [{pattern: 'deleted', requires_tool: 'removed'}]}
  const result = await runSuite({suite: {tests: [testCase, testCase]}, filePath: 'claims.yaml', createProvider: () => ({sendInitial, sendToolResults: vi.fn()}), mcpClient: {} as McpClient, tools: []})
  expect(result.cases.map((test) => test.outcome)).toEqual(['pass', 'fail'])
  expect(sendInitial).toHaveBeenCalledTimes(2)
})
