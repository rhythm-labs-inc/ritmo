import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// uiDir is created for each test to have a real dir for static serving setup
let _uiDir: string

// Mock the simulation route to avoid real OpenAI/MCP calls in server tests
vi.mock('../../src/lib/server/routes/simulate.js', () => ({
  registerSimulateRoutes: vi.fn((fastify: import('fastify').FastifyInstance) => {
    fastify.get('/api/session', async (_req, reply) => {
      return reply.send({status: 'idle', messages: [], trace: []})
    })
    fastify.post('/api/chat', async (_req, reply) => {
      return reply.status(202).send({ok: true})
    })
    fastify.post('/api/reset', async (_req, reply) => {
      return reply.send({ok: true})
    })
  }),
}))

const VALID_CONFIG = {
  version: 1 as const,
  app: {
    name: 'Test App',
    description: 'Test',
    icon: './icon.png',
    screenshots: ['./s1.png', './s2.png', './s3.png'],
  },
  server: {url: 'http://localhost:19999/mcp'},
  simulate: {model: 'gpt-4o-mini', default_context: {locale: 'en-US', timezone: 'America/New_York'}},
  tests: [{file: './tests/smoke.yaml'}],
}

beforeEach(async () => {
  // Create a temp dir with a minimal index.html — used to exercise static serving path
  _uiDir = await mkdtemp(path.join(os.tmpdir(), 'apprhythm-ui-test-'))
  await writeFile(path.join(_uiDir, 'index.html'), '<html><body>AppRhythm</body></html>')
})

afterEach(async () => {
  await rm(_uiDir, {force: true, recursive: true})
  vi.restoreAllMocks()
})

describe('Fastify server — startup and static serving', () => {
  it('starts and listens on a given port and serves API routes', async () => {
    const {createServer} = await import('../../src/lib/server/fastify.js')
    const port = 14321
    const server = await createServer({port, config: VALID_CONFIG})
    await server.listen({port, host: '127.0.0.1'})

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/session`)
      expect(res.status).toBe(200)
      const body = await res.json() as {status: string}
      expect(body.status).toBe('idle')
    } finally {
      await server.close()
    }
  })

  it('GET /api/session returns session state', async () => {
    const {createServer} = await import('../../src/lib/server/fastify.js')
    const port = 14322
    const server = await createServer({port, config: VALID_CONFIG})
    await server.listen({port, host: '127.0.0.1'})

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/session`)
      expect(res.status).toBe(200)
      const body = await res.json() as Record<string, unknown>
      expect(body).toHaveProperty('status')
      expect(body).toHaveProperty('messages')
      expect(body).toHaveProperty('trace')
    } finally {
      await server.close()
    }
  })

  it('POST /api/chat accepts a message and returns 202', async () => {
    const {createServer} = await import('../../src/lib/server/fastify.js')
    const port = 14323
    const server = await createServer({port, config: VALID_CONFIG})
    await server.listen({port, host: '127.0.0.1'})

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({message: 'Hello!'}),
      })
      expect(res.status).toBe(202)
    } finally {
      await server.close()
    }
  })

  it('POST /api/reset returns ok', async () => {
    const {createServer} = await import('../../src/lib/server/fastify.js')
    const port = 14324
    const server = await createServer({port, config: VALID_CONFIG})
    await server.listen({port, host: '127.0.0.1'})

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/reset`, {method: 'POST'})
      expect(res.status).toBe(200)
      const body = await res.json() as {ok: boolean}
      expect(body.ok).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('unknown API route returns 404', async () => {
    const {createServer} = await import('../../src/lib/server/fastify.js')
    const port = 14325
    const server = await createServer({port, config: VALID_CONFIG})
    await server.listen({port, host: '127.0.0.1'})

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/not-a-route`)
      expect(res.status).toBe(404)
    } finally {
      await server.close()
    }
  })
})


it('serves the built SPA and assets without exposing files above the static root', async () => {
  const {createServer} = await import('../../src/lib/server/fastify.js')
  const server = await createServer({port: 0, config: VALID_CONFIG})
  try {
    const html = await readFile(path.resolve('dist-ui/index.html'), 'utf8')
    expect((await server.inject('/')).body).toBe(html)
    expect((await server.inject('/workspace/review')).body).toBe(html)
    const asset = html.match(/src="(\/assets\/[^" ]+\.js)"/)![1]
    const response = await server.inject(asset)
    expect(response.statusCode).toBe(200)
    expect(response.body).toBe(await readFile(path.resolve('dist-ui', '.' + asset), 'utf8'))
    for (const url of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json']) {
      const result = await server.inject(url)
      expect(result.body).not.toContain('"dependencies"')
      expect(result.statusCode === 200 ? result.body === html : result.statusCode >= 400).toBe(true)
    }
    expect((await server.inject('/api/unknown')).statusCode).toBe(404)
  } finally { await server.close() }
})
