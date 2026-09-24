/**
 * RHY-189: standalone widget harness + host options.
 */
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import Fastify from 'fastify'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'

import type {AppRhythmConfig} from '../../src/lib/config-schema.js'
import {registerSimulateRoutes} from '../../src/lib/server/routes/simulate.js'
import {getSessionState, resetSession} from '../../src/lib/server/session-store.js'
import {WidgetHarness, parseFixture} from '../../src/lib/server/widget-harness.js'
import {compliantSpec, startFixtureServer, WIDGET_URI, type FixtureServer} from '../helpers/fixture-server.js'

const EXAMPLE_HTML = path.resolve(__dirname, '../fixtures/harness/widget.html')
const EXAMPLE_FIXTURE = path.resolve(__dirname, '../fixtures/harness/states.json')

const config = (url = ''): AppRhythmConfig => ({
  version: 1, app: {name: 'a', description: 'b', icon: 'c', screenshots: []}, server: {url},
  simulate: {model: 'x', default_context: {locale: 'en', timezone: 'UTC'}}, tests: [{file: 't'}],
})

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('parseFixture', () => {
  it('accepts the states/tools shape and the legacy flat shape', () => {
    const f = parseFixture(JSON.stringify({states: {a: {toolOutput: {x: 1}}}, tools: {t: {content: []}}, toolName: 'n'}))
    expect(Object.keys(f.states)).toEqual(['a'])
    expect(f.tools.t).toEqual({content: []})
    expect(f.toolName).toBe('n')
    const legacy = parseFixture(JSON.stringify({toolInput: {q: 1}, toolOutput: {y: 2}}))
    expect(legacy.states.default.toolInput).toEqual({q: 1})
    expect(() => parseFixture(JSON.stringify({states: {}}))).toThrow(/must not be empty/)
  })
})

describe('WidgetHarness loader', () => {
  it('loads a local file + fixture; ui:// needs --server; ui:// loads from a fixture MCP server', async () => {
    const h = new WidgetHarness({source: EXAMPLE_HTML, fixturePath: EXAMPLE_FIXTURE})
    const loaded = await h.load()
    expect(loaded.source.type).toBe('template')
    expect(loaded.source.content).toContain('window.openai')
    expect(Object.keys(loaded.fixture.states)).toEqual(['intro', 'card-3', 'complete'])
    expect(loaded.fixture.tools.demo_save_card).toBeDefined()

    await expect(new WidgetHarness({source: 'ui://widget/x.html'}).load()).rejects.toThrow(/--server/)

    const srv = await startFixtureServer(compliantSpec())
    try {
      const remote = await new WidgetHarness({source: WIDGET_URI, serverUrl: srv.url}).load()
      expect(remote.source.origin).toBe(WIDGET_URI)
      expect(remote.source.content).toContain('<div id="root">')
      expect(Object.keys(remote.fixture.states)).toEqual(['default'])
    } finally {
      await srv.close()
    }
  })

  it('watches the file and fires on change', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'apprhythm-harness-'))
    const file = path.join(dir, 'w.html')
    await writeFile(file, '<html><body>v1</body></html>')
    const h = new WidgetHarness({source: file, cwd: dir})
    let fired = 0
    expect(h.watch(() => { fired++ })).toBe(true)
    try {
      await writeFile(file, '<html><body>v2</body></html>')
      await waitFor(() => fired > 0, 3000)
      expect(fired).toBeGreaterThan(0)
    } finally {
      h.close()
      await rm(dir, {recursive: true, force: true})
    }
  })
})

describe('Simulator in harness mode via routes', () => {
  let srv: FixtureServer
  beforeAll(async () => { srv = await startFixtureServer(compliantSpec()) })
  afterAll(async () => { await srv.close() })

  it('mounts the first fixture state, switches states, reloads, serves canned tools, records measure + host options', async () => {
    resetSession()
    const app = Fastify()
    const harness = new WidgetHarness({source: EXAMPLE_HTML, fixturePath: EXAMPLE_FIXTURE})
    const sim = registerSimulateRoutes(app, config(), {simulator: {harness, identity: null, hostOptions: {theme: 'dark'}}})
    await app.ready()
    try {
      await waitFor(() => getSessionState().widget !== null)
      let s = getSessionState()
      expect(s.harness?.states).toEqual(['intro', 'card-3', 'complete'])
      expect(s.harness?.activeState).toBe('intro')
      expect(s.harness?.tools).toEqual(['demo_save_card'])
      expect(s.widget?.toolName).toBe('demo_start')
      expect(s.widget?.toolOutput).toEqual({phase: 'building', step: 1, total: 3, values: {}})
      expect(s.widget?.toolResponseMetadata).toEqual({sessionToken: 'sess-demo-0001'})
      expect(s.hostOptions.theme).toBe('dark')
      expect(s.hostOptions.echoSetGlobals).toBe(true)
      expect(sim.isHarness).toBe(true)

      // switch state
      const sw = await app.inject({method: 'POST', url: '/api/harness/state', payload: {state: 'complete'}})
      expect(sw.statusCode).toBe(200)
      s = getSessionState()
      expect(s.harness?.activeState).toBe('complete')
      expect(s.widget?.toolOutput).toEqual({phase: 'complete', values: {card1: 20, card2: 80, card3: 55}})
      expect((await app.inject({method: 'POST', url: '/api/harness/state', payload: {}})).statusCode).toBe(400)

      // canned tool via bridge (no MCP server configured)
      const call = await app.inject({method: 'POST', url: '/api/widget/bridge', payload: {jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'demo_save_card', arguments: {card: 1, value: 42}}}})
      expect((call.json() as {result: {structuredContent: unknown}}).result.structuredContent).toEqual({phase: 'building', step: 2, total: 3, values: {card1: 42}})
      expect(getSessionState().widget?.toolOutput).toEqual({phase: 'building', step: 2, total: 3, values: {card1: 42}})
      const missing = await app.inject({method: 'POST', url: '/api/widget/bridge', payload: {jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: 'nope'}}})
      expect((missing.json() as {error: {message: string}}).error.message).toMatch(/No canned result/)

      // sendFollowUpMessage in harness mode is logged, not run
      await app.inject({method: 'POST', url: '/api/widget/bridge', payload: {jsonrpc: '2.0', id: 3, method: 'ui/sendFollowUpMessage', params: {prompt: 'hi'}}})
      expect(getSessionState().messages.at(-1)).toMatchObject({content: 'hi', origin: 'widget'})
      expect(getSessionState().status).not.toBe('running')

      // measure telemetry + host options + requestDisplayMode → host options
      await app.inject({method: 'POST', url: '/api/widget/bridge', payload: {jsonrpc: '2.0', id: 4, method: 'apprhythm/measure', params: {height: 777}}})
      expect(getSessionState().widget?.measuredHeight).toBe(777)
      const ho = await app.inject({method: 'POST', url: '/api/host-options', payload: {clipToIntrinsicHeight: false, viewport: 'mobile'}})
      expect(ho.json()).toMatchObject({clipToIntrinsicHeight: false, viewport: 'mobile', theme: 'dark'})
      await app.inject({method: 'POST', url: '/api/widget/bridge', payload: {jsonrpc: '2.0', id: 5, method: 'ui/requestDisplayMode', params: {mode: 'pip'}}})
      expect(getSessionState().hostOptions.displayMode).toBe('pip')
      expect(getSessionState().widget?.displayMode).toBe('pip')

      // reload keeps the active state
      const before = getSessionState().harness!.loadedAt
      await new Promise((r) => setTimeout(r, 5))
      await app.inject({method: 'POST', url: '/api/harness/reload'})
      expect(getSessionState().harness!.loadedAt).not.toBe(before)
      expect(getSessionState().harness!.activeState).toBe('complete')

      // reset keeps harness + host options
      await app.inject({method: 'POST', url: '/api/reset'})
      expect(getSessionState().harness?.states).toHaveLength(3)
      expect(getSessionState().hostOptions.viewport).toBe('mobile')
    } finally {
      await sim.close()
      await app.close()
    }
  })

  it('harness routes 404 outside harness mode; ui:// harness with a server works and falls through to real tools', async () => {
    resetSession()
    const app = Fastify()
    const sim = registerSimulateRoutes(app, config(srv.url), {simulator: {identity: null}})
    await app.ready()
    try {
      expect((await app.inject({method: 'POST', url: '/api/harness/state', payload: {state: 'x'}})).statusCode).toBe(404)
      expect((await app.inject({method: 'POST', url: '/api/harness/reload'})).statusCode).toBe(404)
    } finally {
      await sim.close()
      await app.close()
    }

    resetSession()
    const app2 = Fastify()
    const harness = new WidgetHarness({source: WIDGET_URI, serverUrl: srv.url})
    const sim2 = registerSimulateRoutes(app2, config(srv.url), {simulator: {harness, identity: null}})
    await app2.ready()
    try {
      await waitFor(() => getSessionState().widget !== null)
      expect(getSessionState().widget?.source.origin).toBe(WIDGET_URI)
      const call = await app2.inject({method: 'POST', url: '/api/widget/bridge', payload: {jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'demo_create_item', arguments: {name: 'x'}}}})
      expect((call.json() as {result: {structuredContent: unknown}}).result.structuredContent).toEqual({echo: {name: 'x'}})
    } finally {
      await sim2.close()
      await app2.close()
    }
  })
})
