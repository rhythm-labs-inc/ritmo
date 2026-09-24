import path from 'node:path'
import {fileURLToPath} from 'node:url'

import fastifyStatic from '@fastify/static'
import Fastify, {type FastifyInstance} from 'fastify'

import type {AppRhythmConfig} from '../config-schema.js'
import {registerSimulateRoutes, type SimulateRouteOptions} from './routes/simulate.js'

export interface ServerOptions {
  port: number
  config: AppRhythmConfig
  /** Test seam: inject a fake provider / client into the Simulator. */
  simulator?: SimulateRouteOptions['simulator']
}

const DEFAULT_PORT = 4000

export {DEFAULT_PORT}

/**
 * Resolve the directory where the pre-built React SPA lives.
 * The CLI package includes the built UI at `dist-ui/` relative to the package root.
 */
function resolveUiDir(): string {
  // __dirname of this compiled file: <package-root>/dist/lib/server/
  const thisFile = fileURLToPath(import.meta.url)
  const packageRoot = path.resolve(path.dirname(thisFile), '..', '..', '..')
  return path.join(packageRoot, 'dist-ui')
}

/**
 * Create and configure a Fastify instance for the local simulator.
 */
export async function createServer(options: ServerOptions): Promise<FastifyInstance> {
  const fastify = Fastify({logger: false})

  // Serve static React SPA
  const uiDir = resolveUiDir()
  await fastify.register(fastifyStatic, {
    root: uiDir,
    prefix: '/',
  })

  // Register simulation API routes
  registerSimulateRoutes(fastify, options.config, {simulator: options.simulator})

  // For any non-API GET, serve index.html (SPA routing)
  fastify.setNotFoundHandler(async (req, reply) => {
    if (!req.url.startsWith('/api/')) {
      return reply.sendFile('index.html')
    }

    return reply.status(404).send({error: 'Not found'})
  })

  return fastify
}

/**
 * Start the server and return the listening URL.
 */
export async function startServer(options: ServerOptions): Promise<{fastify: FastifyInstance; url: string}> {
  const fastify = await createServer(options)

  await fastify.listen({port: options.port, host: '127.0.0.1'})

  const url = `http://127.0.0.1:${options.port}`
  return {fastify, url}
}
