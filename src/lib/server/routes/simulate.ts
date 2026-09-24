import {registerMcpAuthRoutes} from './mcp-auth.js'
import type {FastifyInstance} from 'fastify'

import type {AppRhythmConfig} from '../../config-schema.js'
import type {BridgeRequest, HostOptions} from '../../simulate/widget/types.js'
import {buildSmokeDraft, saveSmokeDraft, SmokeDraftError} from '../../test-runner/smoke-draft.js'
import {getSessionState} from '../session-store.js'
import {Simulator, type SimulatorOptions} from '../simulator.js'

interface SubmitBody {
  message: string
}

export interface SimulateRouteOptions {
  /** Injectables for tests (see Simulator). */
  simulator?: Partial<Omit<SimulatorOptions, 'config'>>
}

/**
 * Register local simulation API routes on the Fastify instance.
 * Returns the Simulator so callers (and tests) can close it.
 */
export function registerSimulateRoutes(
  fastify: FastifyInstance,
  config: AppRhythmConfig,
  options: SimulateRouteOptions = {},
): Simulator {
  const simulator = new Simulator({config, ...options.simulator})
  registerMcpAuthRoutes(fastify, {root: process.cwd(), config: async () => config, busy: () => getSessionState().status === 'running', changed: async (updated) => {config.server.auth = updated.server.auth; await simulator.dropConnection()}})

  // Connect eagerly so the UI header shows server facts and templates preload before the first turn.
  // Failures are recorded as diagnostics; the first chat turn will retry. (Harness without a server: skip.)
  if (config.server.url) simulator.ensureConnected().catch(() => {})
  if (simulator.isHarness) {
    simulator.loadHarness().then(() => simulator.watchHarness()).catch(() => {})
  }

  // GET /api/session — return current session state
  fastify.get('/api/session', async (_req, reply) => {
    return reply.send(getSessionState())
  })

  fastify.get('/api/smoke-draft', async (_req, reply) => {
    try { return reply.send(buildSmokeDraft(getSessionState())) }
    catch (error) { return reply.status(400).send({error: error instanceof SmokeDraftError ? error.message : 'Could not draft this run.'}) }
  })
  fastify.post('/api/smoke-draft', async (req, reply) => {
    try { return reply.send({file: await saveSmokeDraft(getSessionState(), req.body)}) }
    catch (error) { return reply.status(400).send({error: error instanceof SmokeDraftError ? error.message : 'Could not save the draft.'}) }
  })

  // POST /api/reset — new conversation (keeps the MCP connection)
  fastify.post('/api/reset', async (_req, reply) => {
    simulator.reset()
    return reply.send({ok: true})
  })

  // POST /api/chat — submit a prompt and run the simulation
  fastify.post<{Body: SubmitBody}>('/api/chat', async (req, reply) => {
    const {message} = req.body

    if (!message || message.trim().length === 0) {
      return reply.status(400).send({error: 'message is required'})
    }

    // Only one active run at a time
    if (getSessionState().status === 'running') {
      return reply.status(409).send({error: 'A simulation is already running'})
    }

    // Run in background so this request returns quickly; UI polls /api/session
    simulator.run(message.trim()).catch(() => {
      // errors are captured inside Simulator.run and stored in session state
    })

    return reply.status(202).send({ok: true})
  })

  // POST /api/widget/bridge — JSON-RPC from the widget iframe, proxied by the SPA
  fastify.post<{Body: BridgeRequest}>('/api/widget/bridge', async (req, reply) => {
    const body = req.body
    if (!body || typeof body !== 'object' || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
      return reply.status(400).send({jsonrpc: '2.0', id: (body as {id?: unknown})?.id ?? null, error: {code: -32600, message: 'Invalid JSON-RPC request'}})
    }
    const response = await simulator.handleBridge(body)
    return reply.send(response)
  })

  // POST /api/widget/mounted — the SPA reports the iframe finished loading
  fastify.post('/api/widget/mounted', async (_req, reply) => {
    simulator.markMounted()
    return reply.send({ok: true})
  })

  // POST /api/host-options — toggle host behaviours (echo, clipping, displayMode, theme, viewport)
  fastify.post<{Body: Partial<HostOptions>}>('/api/host-options', async (req, reply) => {
    const body = (req.body ?? {}) as Partial<HostOptions>
    return reply.send(simulator.setHostOptions(body))
  })

  // Harness routes (only meaningful in `ritmo widget` mode)
  fastify.post<{Body: {state?: string}}>('/api/harness/state', async (req, reply) => {
    if (!simulator.isHarness) return reply.status(404).send({error: 'not in harness mode'})
    const name = req.body?.state
    if (!name) return reply.status(400).send({error: 'state is required'})
    simulator.mountHarnessState(name)
    return reply.send({ok: true})
  })
  fastify.post('/api/harness/reload', async (_req, reply) => {
    if (!simulator.isHarness) return reply.status(404).send({error: 'not in harness mode'})
    await simulator.loadHarness()
    return reply.send({ok: true})
  })

  fastify.addHook('onClose', async () => {
    await simulator.close()
  })

  return simulator
}
