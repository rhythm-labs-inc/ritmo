/**
 * RHY-186: simulated host identity (`openai/subject`, `openai/session`) on tools/call.
 */
import {execFile} from 'node:child_process'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {promisify} from 'node:util'

import Fastify from 'fastify'
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest'

import {
  IDENTITY_DIR,
  IDENTITY_FILE,
  identityFromFlags,
  identityMeta,
  persistSubject,
  readPersistedSubject,
  resolveIdentity,
  rotateSession,
} from '../../src/lib/mcp/identity.js'
import {registerSimulateRoutes} from '../../src/lib/server/routes/simulate.js'
import {getSessionState, resetSession} from '../../src/lib/server/session-store.js'
import type {ProviderStepResult, SimulationProvider} from '../../src/lib/simulate/provider/index.js'
import {runSuite} from '../../src/lib/test-runner/engine.js'
import {McpClient} from '../../src/lib/mcp/client.js'
import {compliantSpec, startFixtureServer, type FixtureServer} from '../helpers/fixture-server.js'

const exec = promisify(execFile)
const BIN = path.resolve(__dirname, '../../bin/run.js')

describe('resolveIdentity', () => {
  let dir: string
  beforeAll(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'apprhythm-id-')) })
  afterAll(async () => { await rm(dir, {recursive: true, force: true}) })

  it('generates and persists a subject on first use, reuses it after, rotates with newUser, pins with subject', () => {
    const first = resolveIdentity({}, dir, {})!
    expect(first.subject).toMatch(/^ritmo-user-[0-9a-f]{12}$/)
    expect(first.session).toMatch(/^ritmo-conv-/)
    expect(readPersistedSubject(dir)).toBe(first.subject)

    const again = resolveIdentity({}, dir, {})!
    expect(again.subject).toBe(first.subject)
    expect(again.session).not.toBe(first.session) // new conversation per resolve

    const rotated = resolveIdentity({newUser: true}, dir, {})!
    expect(rotated.subject).not.toBe(first.subject)
    expect(readPersistedSubject(dir)).toBe(rotated.subject)

    const pinned = resolveIdentity({subject: 'user-42'}, dir, {})!
    expect(pinned.subject).toBe('user-42')
    expect(readPersistedSubject(dir)).toBe(rotated.subject) // pin is not persisted

    const fromEnv = resolveIdentity({}, dir, {RITMO_SUBJECT: 'env-user'})!
    expect(fromEnv.subject).toBe('env-user')

    expect(resolveIdentity({noIdentity: true}, dir, {})).toBeNull()
  })

  it('identityMeta / rotateSession / identityFromFlags', () => {
    const id = {subject: 's', session: 'c', locale: 'en-GB'}
    expect(identityMeta(id)).toEqual({'openai/subject': 's', 'openai/session': 'c', 'openai/locale': 'en-GB'})
    expect(identityMeta(null)).toEqual({})
    const r = rotateSession(id)
    expect(r.subject).toBe('s')
    expect(r.session).not.toBe('c')
    expect(identityFromFlags({'forge-subject': 'forged'}, undefined, dir)!.subject).toBe('forged')
    expect(identityFromFlags({'no-identity': true}, undefined, dir)).toBeNull()
  })

  it('persistSubject writes the expected file', async () => {
    persistSubject(dir, 'abc')
    const raw = JSON.parse(await readFile(path.join(dir, IDENTITY_DIR, IDENTITY_FILE), 'utf8')) as {subject: string}
    expect(raw.subject).toBe('abc')
  })
})

describe('identity reaches the server on tools/call', () => {
  let srv: FixtureServer
  beforeAll(async () => { srv = await startFixtureServer(compliantSpec()) })
  afterAll(async () => { await srv.close() })

  it('mcp --call sends openai/subject + openai/session; --no-identity sends none; --forge-subject pins + warns', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'apprhythm-mcpid-'))
    try {
      await exec('node', [BIN, 'mcp', '--server', srv.url, '--call', 'demo_create_item', '--args', '{"name":"a"}'], {cwd: dir})
      const first = srv.calls.at(-1)!.meta!
      expect(first['openai/subject']).toMatch(/^ritmo-user-/)
      expect(first['openai/session']).toMatch(/^ritmo-conv-/)

      await exec('node', [BIN, 'mcp', '--server', srv.url, '--call', 'demo_create_item', '--args', '{"name":"b"}'], {cwd: dir})
      const second = srv.calls.at(-1)!.meta!
      expect(second['openai/subject']).toBe(first['openai/subject']) // persisted per project dir
      expect(second['openai/session']).not.toBe(first['openai/session'])

      await exec('node', [BIN, 'mcp', '--server', srv.url, '--call', 'demo_create_item', '--args', '{}', '--no-identity'], {cwd: dir})
      expect(srv.calls.at(-1)!.meta).toBeUndefined()

      const r = await exec('node', [BIN, 'mcp', '--server', srv.url, '--call', 'demo_create_item', '--args', '{}', '--forge-subject', 'victim-123'], {cwd: dir})
      expect(srv.calls.at(-1)!.meta!['openai/subject']).toBe('victim-123')
      expect(r.stderr + r.stdout).toMatch(/Forging openai\/subject/)
      expect(r.stdout).toContain('_meta: {"openai/subject":"victim-123"')
    } finally {
      await rm(dir, {recursive: true, force: true})
    }
  })

  it('test runner: base identity per suite, new session per case, identity: overrides per turn', async () => {
    const client = new McpClient({serverUrl: srv.url})
    await client.connect()
    try {
      const tools = await client.listTools()
      const callsBefore = srv.calls.length
      const provider = (): SimulationProvider => {
        let n = 0
        const step = async (): Promise<ProviderStepResult> => (n++ % 2 === 0
          ? {content: null, toolCalls: [{id: `t${n}`, name: 'demo_create_item', arguments: {name: 'x'}}]}
          : {content: 'ok', toolCalls: []})
        return {sendInitial: step, sendUserMessage: step, sendToolResults: step, hasHistory: () => n > 0}
      }
      await runSuite({
        suite: {tests: [
          {user: 'one'},
          {turns: [{user: 'a'}, {user: 'b', identity: {session: 'new'}}, {user: 'c', identity: {subject: 'other-user'}}]},
          {user: 'anon', identity: {none: true}},
        ]},
        filePath: 'x',
        createProvider: provider,
        mcpClient: client,
        tools,
        identity: {subject: 'base-user', session: 'ignored'},
      })
      const metas = srv.calls.slice(callsBefore).map((c) => c.meta)
      expect(metas).toHaveLength(5)
      expect(metas[0]!['openai/subject']).toBe('base-user')
      expect(metas[1]!['openai/subject']).toBe('base-user')
      expect(metas[1]!['openai/session']).not.toBe(metas[0]!['openai/session']) // new case → new conversation
      expect(metas[2]!['openai/session']).not.toBe(metas[1]!['openai/session']) // identity.session: new
      expect(metas[3]!['openai/subject']).toBe('other-user')
      expect(metas[4]).toBeUndefined() // identity.none
    } finally {
      await client.close()
    }
  })

  it('simulator: same subject across reset, new session per conversation; identity in session state', async () => {
    process.env.RITMO_OPENAI_API_KEY = 'sk-fake'
    const app = Fastify()
    const scripted = (): SimulationProvider => {
      let n = 0
      const step = async (): Promise<ProviderStepResult> => (n++ % 2 === 0
        ? {content: null, toolCalls: [{id: `t${n}`, name: 'demo_create_item', arguments: {}}]}
        : {content: 'ok', toolCalls: []})
      return {sendInitial: step, sendUserMessage: step, sendToolResults: step, hasHistory: () => n > 0}
    }
    const sim = registerSimulateRoutes(app, {
      version: 1, app: {name: 'a', description: 'b', icon: 'c', screenshots: []}, server: {url: srv.url},
      simulate: {model: 'x', default_context: {locale: 'en', timezone: 'UTC'}}, tests: [{file: 't'}],
    }, {simulator: {createProvider: scripted, identity: {subject: 'sim-user', session: 'sess-1', locale: 'fr-FR'}}})
    await app.ready()
    try {
      resetSession()
      const before = srv.calls.length
      await app.inject({method: 'POST', url: '/api/chat', payload: {message: 'go'}})
      const waitFor = async () => { for (let i = 0; i < 100 && getSessionState().status === 'running'; i++) await new Promise((r) => setTimeout(r, 20)) }
      await waitFor()
      const m1 = srv.calls[before].meta!
      expect(m1).toEqual({'openai/subject': 'sim-user', 'openai/session': 'sess-1', 'openai/locale': 'fr-FR'})
      expect(getSessionState().identity).toEqual({subject: 'sim-user', session: 'sess-1', locale: 'fr-FR'})
      expect(getSessionState().trace[0].requestMeta).toEqual(m1)

      await app.inject({method: 'POST', url: '/api/reset'})
      expect(getSessionState().identity?.subject).toBe('sim-user')
      expect(getSessionState().identity?.session).not.toBe('sess-1')
      await app.inject({method: 'POST', url: '/api/chat', payload: {message: 'again'}})
      await waitFor()
      const m2 = srv.calls.at(-1)!.meta!
      expect(m2['openai/subject']).toBe('sim-user')
      expect(m2['openai/session']).not.toBe('sess-1')
    } finally {
      await sim.close()
      await app.close()
      delete process.env.RITMO_OPENAI_API_KEY
      vi.restoreAllMocks()
    }
  })
})
