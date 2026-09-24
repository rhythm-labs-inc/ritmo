/**
 * RHY-191: golden-prompt assertions, --runs, discovery report.
 */
import {describe, expect, it, vi} from 'vitest'

import type {McpClient} from '../../src/lib/mcp/client.js'
import type {ProviderStepResult, SimulationProvider} from '../../src/lib/simulate/provider/index.js'
import {evaluateAssertions} from '../../src/lib/test-runner/assertions.js'
import {runSuite} from '../../src/lib/test-runner/engine.js'
import {buildDiscoveryReport, formatDiscoveryReport} from '../../src/lib/test-runner/reporters/discovery.js'
import {testSuiteSchema} from '../../src/lib/test-runner/schema.js'

const mcp = {callTool: vi.fn().mockResolvedValue({content: [{type: 'text', text: 'ok'}], isError: false})} as unknown as McpClient
const base = {toolArgs: {}, trace: [], assistantResponse: ''}

describe('golden-prompt assertions', () => {
  it('tools_called: all listed must be called; [] means none', () => {
    expect(evaluateAssertions({tools_called: ['a', 'b']}, {...base, toolsCalled: ['a', 'b', 'c']})[0].passed).toBe(true)
    expect(evaluateAssertions({tools_called: ['a', 'b']}, {...base, toolsCalled: ['a']})[0].passed).toBe(false)
    expect(evaluateAssertions({tools_called: []}, {...base, toolsCalled: []})[0].passed).toBe(true)
    expect(evaluateAssertions({tools_called: []}, {...base, toolsCalled: ['x']})[0].passed).toBe(false)
  })
  it('tools_not_called', () => {
    const r = evaluateAssertions({tools_not_called: ['preview']}, {...base, toolsCalled: ['start', 'preview']})[0]
    expect(r.passed).toBe(false)
    expect(r.actual).toContain('preview')
    expect(evaluateAssertions({tools_not_called: ['preview']}, {...base, toolsCalled: ['start']})[0].passed).toBe(true)
  })
  it('no_claim_without_call: claim without the tool fails; claim with tool passes; no claim passes; bad regex fails loudly', () => {
    const rules = [{pattern: 'reopened|opened the tuner', requires_tool: 'rhythm_builder_start'}]
    const lie = evaluateAssertions({no_claim_without_call: rules}, {...base, toolsCalled: [], assistantResponse: "Yep. I've reopened the tuner with your settings."})[0]
    expect(lie.passed).toBe(false)
    expect(lie.actual).toContain('rhythm_builder_start was not called')
    expect(evaluateAssertions({no_claim_without_call: rules}, {...base, toolsCalled: ['rhythm_builder_start'], assistantResponse: 'I opened the tuner.'})[0].passed).toBe(true)
    expect(evaluateAssertions({no_claim_without_call: rules}, {...base, toolsCalled: [], assistantResponse: 'Nothing to do.'})[0].passed).toBe(true)
    expect(evaluateAssertions({no_claim_without_call: [{pattern: '(', requires_tool: 'x'}]}, {...base, toolsCalled: []})[0].passed).toBe(false)
  })
  it('schema accepts class + new assertions and rejects unknown keys in no_claim_without_call', () => {
    const ok = testSuiteSchema.safeParse({tests: [{class: 'negative', user: 'drum rhythms?', tools_called: []}, {class: 'direct', user: 'x', tools_called: ['a'], tools_not_called: ['b'], no_claim_without_call: [{pattern: 'p', requires_tool: 'a'}]}]})
    expect(ok.success).toBe(true)
    expect(testSuiteSchema.safeParse({tests: [{user: 'x', no_claim_without_call: [{pattern: 'p', requires_tool: 'a', extra: 1}]}]}).success).toBe(false)
    expect(testSuiteSchema.safeParse({tests: [{user: 'x', class: 'weird'}]}).success).toBe(false)
  })
})

/** Deterministic "model": maps user text → tools to call, and a reply. */
function scripted(map: Record<string, {tools: string[]; reply: string}>): () => SimulationProvider {
  return () => {
    let pendingReply = ''
    const turn = async (msg: string): Promise<ProviderStepResult> => {
      const m = map[msg] ?? {tools: [], reply: 'no idea'}
      pendingReply = m.reply
      if (m.tools.length === 0) return {content: m.reply, toolCalls: []}
      return {content: null, toolCalls: m.tools.map((t, i) => ({id: `t${i}`, name: t, arguments: {}}))}
    }
    return {sendInitial: turn, sendUserMessage: turn, sendToolResults: async () => ({content: pendingReply, toolCalls: []}), hasHistory: () => true}
  }
}

describe('discovery report', () => {
  it('computes per-tool precision/recall, per-class stats, confusion; --runs aggregates pass rate', async () => {
    const provider = scripted({
      '@app tune': {tools: ['start'], reply: 'Opened the tuner.'},
      'make it less sycophantic': {tools: [], reply: 'Sure, I will be direct.'},          // indirect miss (FN for start)
      'drum rhythms?': {tools: ['start'], reply: 'Here you go.'},                          // negative triggered (FP for start)
      'can we retune?': {tools: [], reply: "I've reopened the tuner for you."},           // honesty violation
      'preview please': {tools: ['preview'], reply: 'Preview.'},
    })
    const suite = testSuiteSchema.parse({
      suite: 'golden',
      tests: [
        {name: 'direct', class: 'direct', user: '@app tune', tools_called: ['start']},
        {name: 'indirect', class: 'indirect', user: 'make it less sycophantic', tools_called: ['start']},
        {name: 'negative', class: 'negative', user: 'drum rhythms?', tools_called: []},
        {name: 'retune honesty', class: 'direct', user: 'can we retune?', tools_called: ['start'], no_claim_without_call: [{pattern: 'reopened', requires_tool: 'start'}]},
        {name: 'preview', class: 'direct', user: 'preview please', tools_called: ['preview'], tools_not_called: ['start']},
      ],
    })
    const result = await runSuite({suite, filePath: 'g.yaml', createProvider: provider, mcpClient: mcp, tools: ['start', 'preview', 'a', 'b'].map((name) => ({name, inputSchema: {type: 'object' as const}})), runs: 2})
    expect(result.cases.map((c) => c.outcome)).toEqual(['pass', 'fail', 'fail', 'fail', 'pass'])
    expect(result.cases[0].runs).toHaveLength(2)
    expect(result.cases[0].passRate).toBe(1)
    expect(result.cases[1].passRate).toBe(0)
    expect(result.cases[3].assertions.some((a) => a.type === 'no_claim_without_call' && !a.passed)).toBe(true)

    const rep = buildDiscoveryReport(result, '2026-08-17T00:00:00Z')
    const start = rep.tools.find((t) => t.tool === 'start')!
    // per run: direct tp, indirect fn, negative fp, retune fn → ×2 runs
    expect(start).toMatchObject({tp: 2, fp: 2, fn: 4})
    expect(start.precision).toBeCloseTo(0.5)
    expect(start.recall).toBeCloseTo(2 / 6)
    const preview = rep.tools.find((t) => t.tool === 'preview')!
    expect(preview).toMatchObject({tp: 2, fp: 0, fn: 0, precision: 1, recall: 1})
    const neg = rep.classes.find((c) => c.class === 'negative')!
    expect(neg).toMatchObject({cases: 1, invoked: 1, passed: 0})
    expect(rep.confusion.map((c) => c.name).sort()).toEqual(['indirect', 'negative', 'retune honesty'])
    expect(rep.runsPerCase).toBe(2)

    const text = formatDiscoveryReport(rep)
    expect(text).toContain('Fidelity:')
    expect(text).toContain('negative prompts triggered the app')
    expect(text).toContain('retune honesty [direct]')
    // deltas vs a previous report
    const prev = {...rep, tools: rep.tools.map((t) => (t.tool === 'start' ? {...t, precision: 0.25, recall: 0.5} : t))}
    const withDelta = formatDiscoveryReport(rep, prev)
    expect(withDelta).toMatch(/Δprec/)
    expect(withDelta).toMatch(/\+25%/)
  })

  it('runs=1 keeps the plain result shape and tags class/expectedTools', async () => {
    const provider = scripted({'x': {tools: ['a'], reply: 'ok'}})
    const suite = testSuiteSchema.parse({tests: [{class: 'direct', user: 'x', expect_tool: 'a', tools_called: ['b']}]})
    const result = await runSuite({suite, filePath: 'f', createProvider: provider, mcpClient: mcp, tools: ['start', 'preview', 'a', 'b'].map((name) => ({name, inputSchema: {type: 'object' as const}}))})
    expect(result.cases[0].runs).toBeUndefined()
    expect(result.cases[0].class).toBe('direct')
    expect(result.cases[0].expectedTools?.sort()).toEqual(['a', 'b'])
  })
})
