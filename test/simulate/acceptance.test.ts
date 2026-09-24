import {readFileSync} from 'node:fs'
import {describe, expect, it, vi} from 'vitest'
import {runHeadlessLoop} from '../../src/lib/simulate/headless-loop.js'
import {formatToolResultForModel} from '../../src/lib/simulate/messages.js'
import {composeSystemPrompt} from '../../src/lib/simulate/provider/openai.js'
import {measureUsage, summarizeUsage} from '../../src/lib/simulate/usage.js'
import type {McpClient} from '../../src/lib/mcp/client.js'
import type {ProviderStepResult} from '../../src/lib/simulate/provider/index.js'
const sources = JSON.parse(readFileSync(new URL('../fixtures/simulate/source-results.json', import.meta.url), 'utf8'))

describe('source fidelity and usage', () => {
  it('preserves source-to-URL associations, missing links and the widget-only boundary', async () => {
    const toolResult = {content: [{type: 'text', text: JSON.stringify(sources)}], structuredContent: {result: JSON.stringify(sources)}, _meta: {source_url: 'https://secret.example', token: 'secret'}, isError: false}
    expect(formatToolResultForModel(toolResult)).not.toContain('secret')
    expect(composeSystemPrompt()).toMatch(/never borrow.*URL/i)
    const sendToolResults = vi.fn(async () => ({content: '1. **A practical onboarding guide**\n[Listen](https://example.com/onboarding)\n\n2. **Finding the activation moment**\n[Listen](https://example.com/onboarding)', toolCalls: []}))
    const result = await runHeadlessLoop({provider: {sendInitial: async () => ({content: null, toolCalls: [{id: 'a', name: 'search', arguments: {}}]}), sendToolResults}, mcpClient: {callTool: async () => toolResult} as unknown as McpClient, tools: [], message: 'Give two sources'})
    expect(result.answerFindings).toHaveLength(1)
    expect(result.answerFindings[0].sourceTitle).toBe('Finding the activation moment')
    expect(sendToolResults.mock.calls[0][0][0].content).toContain('"url":null')
    expect(sendToolResults.mock.calls[0][0][0].content).not.toContain('secret')
  })
  it('captures multiple completion requests and preserves reported usage before a later failure', async () => {
    const sample = measureUsage('gpt-4o-mini', {prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: {cached_tokens: 40}})
    const observed: ReturnType<typeof summarizeUsage>[] = []
    const first: ProviderStepResult = {content: null, toolCalls: [{id: 'a', name: 'search', arguments: {}}], usage: sample}
    await expect(runHeadlessLoop({provider: {sendInitial: async () => first, sendToolResults: async () => {throw new Error('API failed')}}, mcpClient: {callTool: async () => ({content: 'ok', isError: false})} as unknown as McpClient, tools: [], message: 'Search', onUsage: usage => observed.push(usage)})).rejects.toThrow('API failed')
    expect(observed.at(-1)).toMatchObject({requests: 2, reportedRequests: 1, inputTokens: 100, outputTokens: 20, estimatedCostUsd: null})
  })
  it('prices known models using cached tokens and leaves unknown or absent usage unavailable', () => {
    const usage = measureUsage('gpt-4o-mini-2024-07-18', {prompt_tokens: 1000000, completion_tokens: 1000000, total_tokens: 2000000, prompt_tokens_details: {cached_tokens: 500000}})
    expect(usage?.estimatedCostUsd).toBeCloseTo(0.7125)
    expect(usage?.pricingSource).toContain('2026-09-17')
    expect(measureUsage('unknown', {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2})?.estimatedCostUsd).toBeNull()
    expect(measureUsage('gpt-4o-mini', undefined)).toBeUndefined()
    expect(summarizeUsage([undefined]).estimatedCostUsd).toBeNull()
    expect(measureUsage('gpt-4o-mini', {prompt_tokens: -1, completion_tokens: 1, total_tokens: 0})).toBeUndefined()
  })
})

import {sourceReferences, checkSourceLinks} from '../../src/lib/simulate/source-fidelity.js'
import {runSuite} from '../../src/lib/test-runner/engine.js'
import {getSessionState, resetSession, setUsage} from '../../src/lib/server/session-store.js'

describe('accounting and source regression boundaries', () => {
  it('does not flag a correct URL or a source explicitly left without a link', () => {
    expect(checkSourceLinks('A practical onboarding guide\nhttps://example.com/onboarding\n\nFinding the activation moment\nNo link provided.', sourceReferences({content: [], structuredContent: sources}))).toEqual([])
  })
  it('ignores widget-only metadata while extracting JSON-wrapped records', () => {
    expect(sourceReferences({content: [{type: 'text', text: JSON.stringify(sources)}], structuredContent: {_meta: {title: 'Hidden', url: 'https://secret.example'}}})).toEqual(sources.results.map((r: {title: string; source_url: string | null; snippet: string})=>({title:r.title,url:r.source_url,excerpts:[r.snippet]})))
  })
  it('keeps whole qualified excerpts with their source, deduplicates them, and never clips them', () => {
    const snippet = 'Do not remove setup until import is complete.'
    expect(sourceReferences({content: [], structuredContent: {results: [
      {title: 'Qualified', snippet, snippets: [{text: snippet}, {text: 'First-time users still need setup.'}], _meta: {snippet: 'private'}},
      {title: 'Too long', snippet: 'a'.repeat(6001)},
    ]}})).toEqual([
      {title: 'Qualified', url: null, excerpts: [snippet, 'First-time users still need setup.']},
      {title: 'Too long', url: null},
    ])
  })
  it('bounds added excerpts across records without dropping source references or duplicate-record evidence', () => {
    const records = Array.from({length: 6}, (_, index) => ({title: `Source ${index}`, snippet: String(index).repeat(6000)}))
    const references = sourceReferences({content: [{type: 'text', text: JSON.stringify(records)}], structuredContent: {results: records}})
    expect(references).toHaveLength(6)
    expect(references.flatMap(source => source.excerpts ?? []).map(text => text.length)).toEqual([6000, 6000, 6000, 6000, 6000])
    expect(references[5]).toEqual({title: 'Source 5', url: null})
  })
  it('does not merge distinct excerpt records just because their titles match', () => {
    expect(sourceReferences({content: [], structuredContent: {results: [
      {title: 'Setup guidance', snippet: 'Require approval for managed teams.'},
      {title: 'Setup guidance', snippet: 'Individuals can explore first.'},
    ]}})).toEqual([
      {title: 'Setup guidance', url: null, excerpts: ['Require approval for managed teams.']},
      {title: 'Setup guidance', url: null, excerpts: ['Individuals can explore first.']},
    ])
  })
  it('sums repeat runs and multiple turns without dropping earlier requests', async () => {
    const usage = measureUsage('gpt-4o-mini', {prompt_tokens: 10, completion_tokens: 2, total_tokens: 12})
    const provider = () => ({sendInitial: async () => ({content: 'ok', toolCalls: [], usage}), sendUserMessage: async () => ({content: 'ok', toolCalls: [], usage}), sendToolResults: async () => ({content: 'ok', toolCalls: [], usage})})
    const result = await runSuite({suite: {suite: 'Usage fixture', tests: [{name: 'Two turns', turns: [{user:'first'}, {user:'second'}]}]}, filePath:'fixture', createProvider:provider, mcpClient:{} as McpClient, tools:[], runs:2})
    expect(result.usage).toMatchObject({requests:4,reportedRequests:4,inputTokens:40,outputTokens:8,totalTokens:48})
    expect(result.cases[0].usage?.requests).toBe(4)
  })
  it('clears conversation usage on reset', () => {
    setUsage(summarizeUsage([measureUsage('test', {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2})]))
    expect(getSessionState().usage?.requests).toBe(1)
    resetSession()
    expect(getSessionState().usage).toBeUndefined()
  })
})

// A combined or ambiguous heading ends the preceding source's diagnostic section.
it('does not assign links under ambiguous titles to the preceding source', () => {
  expect(checkSourceLinks('First title\nNo link.\nSecond title and Third title\nhttps://example.com/third', [{title:'First title',url:null},{title:'Second title',url:null},{title:'Third title',url:'https://example.com/third'}])).toEqual([])
})
