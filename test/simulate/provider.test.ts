import {describe, expect, it, vi} from 'vitest'
import {readFileSync} from 'node:fs'
import type {McpClient} from '../../src/lib/mcp/client.js'
import {runHeadlessLoop} from '../../src/lib/simulate/headless-loop.js'

const summaryCases: Array<{id: string; prompt: string; results: Array<{snippet: string}>}> = JSON.parse(readFileSync(new URL('../fixtures/simulate/summary-cases.json', import.meta.url), 'utf8'))

// Mock the OpenAI SDK so no network happens
const create = vi.fn()
vi.mock('openai', () => ({
  default: class {
    chat = {completions: {create}}
    constructor(_: unknown) {}
  },
}))

const {OpenAIProvider, composeSystemPrompt} = await import('../../src/lib/simulate/provider/openai.js')

function reply(content: string) {
  return {choices: [{message: {role: 'assistant', content, tool_calls: []}}]}
}

describe('composeSystemPrompt', () => {
  it('falls back to the generic prompt and otherwise appends the server instructions', () => {
    expect(composeSystemPrompt()).toMatch(/helpful assistant/)
    expect(composeSystemPrompt('   ')).toMatch(/helpful assistant/)
    const p = composeSystemPrompt('Use notes tools when the user asks about notes.')
    expect(p).toMatch(/helpful assistant/)
    expect(p).toContain('The connected app provided these instructions')
    expect(p).toContain('Use notes tools when the user asks about notes.')
  })
})

describe('OpenAIProvider multi-turn (RHY-65)', () => {
  it('sendInitial builds system+user; sendUserMessage appends to the SAME history', async () => {
    create.mockReset()
    create.mockResolvedValueOnce(reply('hi')).mockResolvedValueOnce(reply('again'))
    const p = new OpenAIProvider({apiKey: 'k', model: 'm', instructions: 'Server says X.'})
    expect(p.hasHistory()).toBe(false)
    await p.sendInitial('hello', [])
    expect(p.hasHistory()).toBe(true)
    await p.sendUserMessage('second')
    // (the SDK is handed the live history array, so inspect the provider's own copy)
    const msgs = p.getMessages()
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user', 'assistant'])
    expect(String(msgs[0].content)).toContain('Server says X.')
    expect(msgs[3].content).toBe('second')
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('sendUserMessage before sendInitial throws', async () => {
    const p = new OpenAIProvider({apiKey: 'k', model: 'm'})
    await expect(p.sendUserMessage('x')).rejects.toThrow(/before sendInitial/)
  })

  it('sendInitial again starts a fresh conversation', async () => {
    create.mockReset()
    create.mockResolvedValue(reply('ok'))
    const p = new OpenAIProvider({apiKey: 'k', model: 'm'})
    await p.sendInitial('a', [])
    await p.sendUserMessage('b')
    await p.sendInitial('c', [])
    expect(p.getMessages().map((m) => m.role)).toEqual(['system', 'user', 'assistant'])
  })
})

describe('provider usage retention', () => {
  it('returns token usage and a sourced estimate even for an empty completion', async () => {
    create.mockReset()
    create.mockResolvedValue({model: 'gpt-4o-mini-2024-07-18', service_tier: 'default', choices: [], usage: {prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_tokens_details: {cached_tokens: 40}}})
    const provider = new OpenAIProvider({apiKey: 'fixture', model: 'gpt-4o-mini'})
    expect(await provider.sendInitial('test', [])).toMatchObject({usage: {inputTokens: 100, outputTokens: 5, cachedInputTokens: 40, totalTokens: 105}})
  })
  it('does not invent zero usage when the provider omits it', async () => {
    create.mockReset()
    create.mockResolvedValue(reply('ok'))
    const provider = new OpenAIProvider({apiKey: 'fixture', model: 'gpt-4o-mini'})
    expect((await provider.sendInitial('test', [])).usage).toBeUndefined()
  })
})

describe('summary evidence transport (not a model accuracy test)', () => {
  it.each(summaryCases)('retains the complete qualified excerpts for $id', async (scenario) => {
    create.mockReset()
    create.mockResolvedValueOnce({choices: [{message: {
      role: 'assistant', content: null,
      tool_calls: [{id: 'search-1', type: 'function', function: {name: 'search_content', arguments: '{}'}}],
    }}]}).mockResolvedValueOnce(reply('An unsupported universal recommendation.'))
    const provider = new OpenAIProvider({apiKey: 'fixture', model: 'fixture', instructions: 'Search the archive.'})
    const result = await runHeadlessLoop({
      provider,
      mcpClient: {callTool: async () => ({
        content: [{type: 'text', text: JSON.stringify({results: scenario.results})}],
        _meta: {token: 'widget-only-secret'}, isError: false,
      })} as unknown as McpClient,
      tools: [], message: scenario.prompt,
    })
    const messages = provider.getMessages()
    const toolMessage = messages.find(message => message.role === 'tool')
    const evidence = JSON.parse(String(toolMessage?.content).split('\n\nSource references')[0])
    expect(evidence.results).toEqual(scenario.results)
    const references = JSON.parse(String(toolMessage?.content).split('Source references from this result (null means no URL was provided):\n')[1])
    expect(references.map((reference: {excerpts: string[]}) => reference.excerpts)).toEqual(scenario.results.map(source => [source.snippet]))
    expect(JSON.stringify(messages)).not.toContain('widget-only-secret')
    expect(messages[0].content).toBe(composeSystemPrompt('Search the archive.'))
    expect(create).toHaveBeenCalledTimes(2)
    // Link checks cannot establish semantic accuracy, and no hidden repair call is made.
    expect(result.assistantResponse).toBe('An unsupported universal recommendation.')
    expect(result.answerFindings).toEqual([])
  })
})
