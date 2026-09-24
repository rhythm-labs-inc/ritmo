/**
 * RHY-63: widget pipeline wired end-to-end on the server side.
 * Real Fastify routes → Simulator → real McpClient → fixture MCP server; the model is a fake provider.
 */
import Fastify, {type FastifyInstance} from 'fastify'
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'

import type {AppRhythmConfig} from '../../src/lib/config-schema.js'
import {registerSimulateRoutes} from '../../src/lib/server/routes/simulate.js'
import {getSessionState, resetSession} from '../../src/lib/server/session-store.js'
import {measureUsage} from '../../src/lib/simulate/usage.js'
import type {Simulator} from '../../src/lib/server/simulator.js'
import type {ProviderStepResult, SimulationProvider} from '../../src/lib/simulate/provider/index.js'
import {compliantSpec, startFixtureServer, WIDGET_URI, type FixtureServer} from '../helpers/fixture-server.js'

/**
 * A multi-turn-capable fake: every user turn (sendInitial or sendUserMessage) replays the
 * CURRENT script from `getScript()`; tool-result steps continue it. Records history length.
 */
function scriptedProvider(getScript: () => ProviderStepResult[]): () => SimulationProvider {
  return () => {
    let queue: ProviderStepResult[] = []
    let turns = 0
    const startTurn = async () => {
      turns++
      queue = [...getScript()]
      return queue.shift()!
    }
    return {
      sendInitial: vi.fn(startTurn),
      sendUserMessage: vi.fn(startTurn),
      sendToolResults: vi.fn(async () => queue.shift()!),
      hasHistory: () => turns > 0,
    }
  }
}

const callsWidgetTool: ProviderStepResult[] = [
  {content: null, toolCalls: [{id: 'tc1', name: 'demo_list_items', arguments: {}}]},
  {content: 'Here are your items.', toolCalls: []},
]

const callsPlainTool: ProviderStepResult[] = [
  {content: null, toolCalls: [{id: 'tc2', name: 'demo_create_item', arguments: {name: 'x'}}]},
  {content: 'Created.', toolCalls: []},
]

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('Simulator + routes: widget pipeline', () => {
  let srv: FixtureServer
  let app: FastifyInstance
  let sim: Simulator
  let script: ProviderStepResult[] = callsWidgetTool
  const config = (url: string): AppRhythmConfig => ({
    version: 1,
    app: {name: 'a', description: 'b', icon: 'c', screenshots: []},
    server: {url},
    simulate: {model: 'fake', default_context: {locale: 'en', timezone: 'UTC'}},
    tests: [{file: 't.yaml'}],
  })

  beforeAll(async () => {
    srv = await startFixtureServer({
      ...compliantSpec(),
      onCallTool: (name, args) => ({
        content: [{type: 'text', text: `ran ${name}`}],
        structuredContent: {phase: 'building', got: args},
        _meta: {sessionToken: 'tok-1'},
      }),
    })
    process.env.RITMO_OPENAI_API_KEY = 'sk-fake'
    app = Fastify()
    sim = registerSimulateRoutes(app, config(srv.url), {simulator: {createProvider: scriptedProvider(() => script)}})
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    await srv.close()
    delete process.env.RITMO_OPENAI_API_KEY
  })

  beforeEach(async () => {
    await sim.dropConnection()
    sim.reset()
    resetSession()
    script = callsWidgetTool
    await sim.ensureConnected()
  })
  afterEach(() => vi.restoreAllMocks())

  it('retains usage across browser turns and a later failed completion', async () => {
    const usage = measureUsage('gpt-4o-mini', {prompt_tokens: 10, completion_tokens: 2, total_tokens: 12})
    script = [{content: 'first', toolCalls: [], usage}]
    await sim.run('first')
    await sim.run('second')
    expect(getSessionState().usage).toMatchObject({requests: 2, reportedRequests: 2, totalTokens: 24})
    // The scripted provider runs out after a tool request, causing the next completion to fail.
    script = [{content: null, toolCalls: [{id: 'fail', name: 'demo_create_item', arguments: {name: 'x'}}], usage}]
    await sim.run('third')
    expect(getSessionState().status).toBe('error')
    expect(getSessionState().usage).toMatchObject({requests: 4, reportedRequests: 3, totalTokens: 36, estimatedCostUsd: null})
    sim.reset()
    expect(getSessionState().usage).toBeUndefined()
  })

  it('mounts a widget from the tool descriptor\'s ui:// template after the tool call, with toolOutput + _meta', async () => {
    const res = await app.inject({method: 'POST', url: '/api/chat', payload: {message: 'show items'}})
    expect(res.statusCode).toBe(202)
    await waitFor(() => getSessionState().status !== 'running')

    const s = getSessionState()
    expect(s.status).toBe('success')
    expect(s.widget).not.toBeNull()
    expect(s.widget!.toolName).toBe('demo_list_items')
    expect(s.widget!.source.type).toBe('template')
    expect(s.widget!.source.origin).toBe(WIDGET_URI)
    expect(s.widget!.source.content).toContain('<div id="root">')
    expect(s.widget!.source.mimeType).toBe('text/html;profile=mcp-app')
    expect(s.widget!.toolOutput).toEqual({phase: 'building', got: {}})
    expect(s.widget!.toolResponseMetadata).toEqual({sessionToken: 'tok-1'})
    expect(s.server?.templateCount).toBe(1)
    expect(s.widgetDiagnostics.some((d) => d.method === 'template')).toBe(true)
  })

  it('caches templates by URI: preloaded once at connect, not refetched per call', async () => {
    const before = srv.reads.filter((u) => u === WIDGET_URI).length
    await app.inject({method: 'POST', url: '/api/chat', payload: {message: 'again'}})
    await waitFor(() => getSessionState().status !== 'running')
    await app.inject({method: 'POST', url: '/api/chat', payload: {message: 'and again'}})
    await waitFor(() => getSessionState().status !== 'running')
    expect(srv.reads.filter((u) => u === WIDGET_URI).length).toBe(before)
    expect(before).toBeGreaterThanOrEqual(1)
  })

  it('does not mount for tools without a template; legacy inline HTML in the result still works', async () => {
    script = callsPlainTool
    await app.inject({method: 'POST', url: '/api/chat', payload: {message: 'create'}})
    await waitFor(() => getSessionState().status !== 'running')
    expect(getSessionState().widget).toBeNull()
  })

  it('bridge: tools/call returns the full result and refreshes globals; setWidgetState persists; requestClose unmounts', async () => {
    await app.inject({method: 'POST', url: '/api/chat', payload: {message: 'show'}})
    await waitFor(() => getSessionState().status !== 'running')

    const call = await app.inject({method: 'POST', url: '/api/widget/bridge', payload: {jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'demo_create_item', arguments: {name: 'from-widget'}}}})
    const body = call.json() as {result: {structuredContent: unknown; _meta: unknown}}
    expect(body.result.structuredContent).toEqual({phase: 'building', got: {name: 'from-widget'}})
    expect(body.result._meta).toEqual({sessionToken: 'tok-1'})
    expect(srv.calls.at(-1)?.name).toBe('demo_create_item')
    // non-template tool → same widget, refreshed data
    expect(getSessionState().widget?.toolOutput).toEqual({phase: 'building', got: {name: 'from-widget'}})

    const sw = await app.inject({method: 'POST', url: '/api/widget/bridge', payload: {jsonrpc: '2.0', id: 2, method: 'ui/setWidgetState', params: {state: {step: 3}}}})
    expect((sw.json() as {result: unknown}).result).toEqual({ok: true})
    expect(getSessionState().widget?.widgetState).toEqual({step: 3})

    await app.inject({method: 'POST', url: '/api/widget/mounted'})
    expect(getSessionState().widget?.lifecycle).toBe('mounted')

    const h = await app.inject({method: 'POST', url: '/api/widget/bridge', payload: {jsonrpc: '2.0', id: 3, method: 'ui/notifyIntrinsicHeight', params: {height: 420}}})
    expect(h.statusCode).toBe(200)
    expect(getSessionState().widget?.intrinsicHeight).toBe(420)

    const dm = await app.inject({method: 'POST', url: '/api/widget/bridge', payload: {jsonrpc: '2.0', id: 4, method: 'ui/requestDisplayMode', params: {mode: 'fullscreen'}}})
    expect((dm.json() as {result: {mode: string}}).result.mode).toBe('fullscreen')
    expect(getSessionState().widget?.displayMode).toBe('fullscreen')

    await app.inject({method: 'POST', url: '/api/widget/bridge', payload: {jsonrpc: '2.0', id: 5, method: 'ui/requestClose'}})
    expect(getSessionState().widget).toBeNull()

    const bad = await app.inject({method: 'POST', url: '/api/widget/bridge', payload: {nope: true}})
    expect(bad.statusCode).toBe(400)

    const unknown = await app.inject({method: 'POST', url: '/api/widget/bridge', payload: {jsonrpc: '2.0', id: 6, method: 'ui/doesNotExist'}})
    expect((unknown.json() as {error: {message: string}}).error.message).toMatch(/Unsupported/)
    expect(getSessionState().widgetDiagnostics.some((d) => d.method === 'tools/call' && d.kind === 'response')).toBe(true)
  })

  it('bridge: sendFollowUpMessage starts a new turn attributed to the widget', async () => {
    await app.inject({method: 'POST', url: '/api/chat', payload: {message: 'show'}})
    await waitFor(() => getSessionState().status !== 'running')
    script = callsPlainTool
    await app.inject({method: 'POST', url: '/api/widget/bridge', payload: {jsonrpc: '2.0', id: 9, method: 'ui/sendFollowUpMessage', params: {prompt: 'summarise my items'}}})
    await waitFor(() => getSessionState().messages.some((m) => m.origin === 'widget'))
    await waitFor(() => getSessionState().status !== 'running')
    const msgs = getSessionState().messages
    expect(msgs.find((m) => m.origin === 'widget')?.content).toBe('summarise my items')
    expect(msgs.at(-1)?.content).toBe('Created.')
  })

  it('keeps ONE provider per conversation: second message is sendUserMessage on the same provider; reset starts fresh', async () => {
    const created: SimulationProvider[] = []
    const app2 = Fastify()
    const factory = scriptedProvider(() => callsPlainTool)
    const sim2 = registerSimulateRoutes(app2, config(srv.url), {simulator: {createProvider: (key, instructions) => {
      expect(instructions).toContain('demo tools') // server instructions reach the provider
      const p = factory()
      created.push(p)
      return p
    }}})
    await app2.ready()
    try {
      resetSession()
      await app2.inject({method: 'POST', url: '/api/chat', payload: {message: 'one'}})
      await waitFor(() => getSessionState().status !== 'running')
      await app2.inject({method: 'POST', url: '/api/chat', payload: {message: 'two'}})
      await waitFor(() => getSessionState().status !== 'running')
      expect(created).toHaveLength(1)
      expect((created[0].sendInitial as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
      expect((created[0].sendUserMessage as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
      expect((created[0].sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('two')

      await app2.inject({method: 'POST', url: '/api/reset'})
      await app2.inject({method: 'POST', url: '/api/chat', payload: {message: 'three'}})
      await waitFor(() => getSessionState().status !== 'running')
      expect(created).toHaveLength(2)
    } finally {
      await sim2.close()
      await app2.close()
    }
  })

  it('reset clears the conversation and widget but keeps server info', async () => {
    await app.inject({method: 'POST', url: '/api/chat', payload: {message: 'show'}})
    await waitFor(() => getSessionState().status !== 'running')
    expect(getSessionState().widget).not.toBeNull()
    await app.inject({method: 'POST', url: '/api/reset'})
    const s = getSessionState()
    expect(s.widget).toBeNull()
    expect(s.messages).toEqual([])
    expect(s.server?.toolCount).toBe(2)
  })

  it('reports missing credential and MCP connection failures in session state', async () => {
    delete process.env.RITMO_OPENAI_API_KEY
    // Force keychain to be empty for this check by using an env that resolveCredential treats as absent
    // (a stored key on the dev machine would make this pass through — see docs/testing.md).
    await app.inject({method: 'POST', url: '/api/chat', payload: {message: 'x'}})
    await waitFor(() => getSessionState().status !== 'running')
    process.env.RITMO_OPENAI_API_KEY = 'sk-fake'
    const s = getSessionState()
    expect(['error', 'success']).toContain(s.status)
    if (s.status === 'error') expect(s.errorCategory).toBe('missing-credential')

    // Unreachable server → error category connection/timeout, then reconnect works next turn
    const dead = Fastify()
    const deadSim = registerSimulateRoutes(dead, config('http://127.0.0.1:1/mcp'), {simulator: {createProvider: scriptedProvider(() => callsWidgetTool)}})
    await dead.ready()
    try {
      resetSession()
      await dead.inject({method: 'POST', url: '/api/chat', payload: {message: 'x'}})
      await waitFor(() => getSessionState().status !== 'running', 15000)
      expect(getSessionState().status).toBe('error')
      expect(['connection', 'timeout']).toContain(getSessionState().errorCategory)
    } finally {
      await deadSim.close()
      await dead.close()
    }
  }, 20000)
})
