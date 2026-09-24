import {randomBytes, timingSafeEqual} from 'node:crypto'
import type {FastifyInstance} from 'fastify'
import type {AppRhythmConfig} from '../../config-schema.js'
import {saveMcpAuth} from '../../mcp/auth-config.js'
import {mcpAuthSchema} from '../../mcp/auth-schema.js'
import {createConnection} from '../../mcp/connection.js'
import {McpOAuthProvider} from '../../mcp/oauth.js'
import {McpError} from '../../mcp/errors.js'

/** Server-side credentials only. The browser sees references and safe status. */
export function registerMcpAuthRoutes(app: FastifyInstance, options: {
  prefix?: string
  root: string
  config: () => Promise<AppRhythmConfig>
  changed: (config: AppRhythmConfig) => Promise<void>
  busy: () => boolean
}): void {
  const prefix = options.prefix ?? '/api/mcp-auth'
  const session = randomBytes(32).toString('hex')
  let login: Promise<void> | undefined
  let controller: AbortController | undefined
  let lastError: string | undefined
  const safeError = (error: unknown) => error instanceof McpError ? error.message : 'Could not update MCP authentication. Check the configuration and keychain access.'
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith(prefix)) return
    const address = app.server.address()
    const port = address && typeof address === 'object' ? address.port : undefined
    const host = req.headers.host ?? ''
    const localHost = port ? ['127.0.0.1:' + port, 'localhost:' + port].includes(host) : /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)
    if (!localHost || (req.headers.origin && req.headers.origin !== `http://${host}`)) return reply.status(403).send({error: 'Use this local Ritmo window to manage authentication.'})
    reply.header('cache-control', 'no-store')
    if (req.method !== 'GET') {
      const supplied = Buffer.from(String(req.headers['x-ritmo-auth-session'] ?? ''))
      const expected = Buffer.from(session)
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reply.status(403).send({error: 'Reload before changing authentication.'})
      if (options.busy()) return reply.status(409).send({error: 'Finish or cancel the current run before changing authentication.'})
    }
  })
  app.get(prefix, async (_req, reply) => {
    const config = await options.config()
    let status: unknown
    try {
      const connection = await createConnection(config.server.url, config.server.auth)
      status = connection.oauth?.status() ?? {mode: config.server.auth?.headers ? 'headers' : 'none', status: 'configured'}
    } catch (error) { status = {status: 'unavailable', error: safeError(error)} }
    return reply.send({session, configuration: config.server.auth ?? {}, status, loggingIn: Boolean(login), error: lastError})
  })
  app.post(prefix + '/configure', async (req, reply) => {
    if (login) return reply.status(409).send({error: 'Cancel the pending login before editing authentication.'})
    const parsed = mcpAuthSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({error: 'Use environment or keychain references. OAuth cannot be combined with an Authorization header.'})
    try {
      const config = await options.config()
      await saveMcpAuth(options.root, config.server.url, parsed.data)
      config.server.auth = parsed.data
      await options.changed(config)
      lastError = undefined
      return {ok: true}
    } catch (error) { return reply.status(400).send({error: safeError(error)}) }
  })
  app.post(prefix + '/login', async (_req, reply) => {
    if (login) return reply.status(409).send({error: 'A login is already pending.'})
    try {
      const config = await options.config()
      const connection = await createConnection(config.server.url, config.server.auth)
      if (!connection.oauth) return reply.status(400).send({error: 'Configure OAuth before connecting.'})
      controller = new AbortController(); lastError = undefined
      login = connection.oauth.login({signal: controller.signal, request: connection.fetch})
        .then(() => options.changed(config))
        .catch((error) => { lastError = safeError(error) })
        .finally(() => { login = undefined; controller = undefined })
      return reply.status(202).send({ok: true})
    } catch (error) { return reply.status(400).send({error: safeError(error)}) }
  })
  app.post(prefix + '/cancel', async () => { controller?.abort(); await login; return {ok: true} })
  app.post(prefix + '/clear', async (_req, reply) => {
    controller?.abort(); await login
    try {
      const config = await options.config()
      if (config.server.auth?.oauth) await McpOAuthProvider.clearSession(config.server.url, config.server.auth.oauth)
      await options.changed(config)
      lastError = undefined
      return {ok: true}
    } catch (error) { return reply.status(400).send({error: safeError(error)}) }
  })
  app.addHook('onClose', async () => { controller?.abort(); await login })
}
