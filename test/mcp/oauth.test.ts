import {afterEach, describe, expect, it, vi} from 'vitest'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {Config} from '@oclif/core'
import open from 'open'
import McpAuth from '../../src/commands/auth/mcp.js'
import {setBackend} from '../../src/lib/credentials/store.js'
import {McpOAuthProvider} from '../../src/lib/mcp/oauth.js'
import {McpClient} from '../../src/lib/mcp/client.js'
import {createConnection} from '../../src/lib/mcp/connection.js'
import {memoryOAuthStore, oauthFixture} from '../helpers/oauth-fixture.js'

vi.mock('open', () => ({default: vi.fn()}))

const fixtures: Awaited<ReturnType<typeof oauthFixture>>[] = []
afterEach(async () => { await Promise.all(fixtures.splice(0).map((f) => f.close())) })
async function fixture(options?: Parameters<typeof oauthFixture>[0]) { const f = await oauthFixture(options); fixtures.push(f); return f }

describe('MCP OAuth fixture acceptance', () => {
  it.each([false, true].flatMap((json) => ['none', 'exchange', 'keychain'].map((failure) => ({json, failure}))))('CLI reports actual sign-in completion (json=$json, failure=$failure)', async ({json, failure}) => {
    const f = await fixture({rejectTokens: failure === 'exchange'})
    const root = await mkdtemp(path.join(tmpdir(), 'ritmo-oauth-cli-'))
    const values = new Map<string, string>()
    const output: string[] = []
    let persisted = false
    const config = await Config.load(path.resolve(__dirname, '../..'))
    const tty = [process.stdin, process.stdout].map((stream) => Object.getOwnPropertyDescriptor(stream, 'isTTY'))
    try {
      await writeFile(path.join(root, 'apprhythm.yaml'), JSON.stringify({version: 1, app: {name: 'Fixture', description: 'Synthetic', icon: 'icon.png'}, server: {url: f.url, auth: {oauth: {}}}, simulate: {model: 'fixture', default_context: {locale: 'en', timezone: 'UTC'}}, tests: [{file: 'smoke.yaml'}]}))
      vi.spyOn(process, 'cwd').mockReturnValue(root)
      vi.stubEnv('RITMO_NO_KEYCHAIN', '')
      for (const stream of [process.stdin, process.stdout]) Object.defineProperty(stream, 'isTTY', {configurable: true, value: true})
      setBackend({
        async getPassword(_service, key) { return values.get(key) ?? null },
        async deletePassword(_service, key) { return values.delete(key) },
        async setPassword(_service, key, value) {
          if (JSON.parse(value).tokens) {
            expect(output.join('\n')).not.toContain('Signed in')
            if (!json) expect(output.join('\n')).toContain('Completing sign-in')
            if (failure === 'keychain') throw new Error('synthetic persistence failure')
            persisted = true
          }
          values.set(key, value)
        },
      })
      vi.mocked(open).mockImplementation(async (url) => {
        if (!json) expect(output.join('\n')).toContain('Waiting for browser sign-in')
        await f.openUrl(new URL(url))
        return undefined as never
      })
      const command = new McpAuth(['--login', ...(json ? ['--json'] : [])], config)
      vi.spyOn(command, 'log').mockImplementation((message) => {
        if (String(message).includes('Signed in') || String(message).includes('"status": "connected"')) expect(persisted).toBe(true)
        output.push(String(message))
      })
      if (failure === 'none') {
        await command.run()
        if (json) expect(JSON.parse(output.join('\n'))).toMatchObject({mode: 'oauth', status: 'connected'})
        else expect(output.join('\n')).toContain(`Signed in to ${f.url}`)
      } else {
        await expect(command.run()).rejects.toMatchObject({message: expect.stringContaining('[authentication]')})
        expect(output.join('\n')).not.toContain('Signed in')
        if (json) expect(output).toEqual([])
        else expect(output.join('\n')).toContain('Sign-in did not complete')
      }
      if (f.accessToken) expect(output.join('\n')).not.toContain(f.accessToken)
    } finally {
      vi.restoreAllMocks(); vi.unstubAllEnvs(); setBackend(null)
      for (const [index, stream] of [process.stdin, process.stdout].entries()) {
        if (tty[index]) Object.defineProperty(stream, 'isTTY', tty[index]!)
        else Reflect.deleteProperty(stream, 'isTTY')
      }
      await rm(root, {recursive: true, force: true})
    }
  })

  it('reports browser and exchange progress and waits for secure persistence before resolving', async () => {
    const f = await fixture()
    const store = memoryOAuthStore()
    const events: string[] = []
    const provider = await McpOAuthProvider.create(f.url, {}, {store: {
      ...store,
      async write(key, value) {
        if (JSON.parse(value).tokens) {
          expect(events).toEqual(['waiting', 'browser opened', 'completing'])
          await store.write(key, value)
          events.push('persisted')
        } else await store.write(key, value)
      },
    }})
    let callbackPage = ''
    await provider.login({
      onProgress: (phase) => events.push(phase),
      openUrl: async (url) => {
        expect(events).toEqual(['waiting'])
        events.push('browser opened')
        callbackPage = await (await fetch(url)).text()
      },
    })
    events.push('resolved')
    expect(events).toEqual(['waiting', 'browser opened', 'completing', 'persisted', 'resolved'])
    expect(callbackPage).toContain('Return to Ritmo for sign-in confirmation')
    expect((await McpOAuthProvider.create(f.url, {}, {store})).status().status).toBe('connected')
  })

  it('does not complete login when token exchange or secure persistence fails', async () => {
    for (const rejectTokens of [true, false]) {
      const f = await fixture({rejectTokens})
      const store = memoryOAuthStore()
      const provider = await McpOAuthProvider.create(f.url, {}, {store: {
        ...store,
        async write(key, value) {
          if (JSON.parse(value).tokens) throw new Error('fixture keychain denied')
          await store.write(key, value)
        },
      }})
      const phases: string[] = []
      await expect(provider.login({openUrl: f.openUrl, onProgress: (phase) => phases.push(phase)})).rejects.toMatchObject({category: 'authentication'})
      expect(phases).toEqual(['waiting', 'completing'])
      expect((await McpOAuthProvider.create(f.url, {}, {store})).status().status).toBe('disconnected')
    }
  })

  it('logs in with PKCE and DCR, persists, reconnects and refreshes across MCP operations', async () => {
    const f = await fixture()
    const store = memoryOAuthStore()
    let now = Date.now()
    const oauthOptions = {store, now: () => now}
    const provider = await McpOAuthProvider.create(f.url, {}, oauthOptions)
    await provider.login({openUrl: f.openUrl})
    expect(provider.status().status).toBe('connected')
    expect(provider.tokens()?.access_token).toBe(f.accessToken)
    const firstToken = f.accessToken
    now += 65_000
    const client = new McpClient({serverUrl: f.url, auth: {oauth: {}}, oauthOptions})
    try {
      await client.connect()
      expect(f.accessToken).not.toBe(firstToken)
      expect((await client.listToolsRaw())[0].name).toBe('echo')
      await client.callTool('echo', {})
      expect((await client.readResourceRaw('ui://oauth-fixture.html'))[0].text).toContain('Authenticated')
    } finally { await client.close() }
    expect(f.requests.filter((r) => r.url.includes('.well-known')).every((r) => !r.headers.authorization && !r.headers['x-api-key'])).toBe(true)
    expect(f.requests.filter((r) => r.url === '/register')).toHaveLength(1)
    expect(f.requests.filter((r) => r.url === '/token')).toHaveLength(2)
  })

  it('supports a pre-registered client when dynamic registration is unavailable', async () => {
    const f = await fixture({registration: false})
    const provider = await McpOAuthProvider.create(f.url, {client_id: 'registered-client'}, {store: memoryOAuthStore()})
    await provider.login({openUrl: f.openUrl})
    expect(provider.status().status).toBe('connected')
    expect(f.requests.some((r) => r.url === '/register')).toBe(false)
  })

  it.each(['client_secret_basic', 'client_secret_post'] as const)('uses the registered %s method for exchange, saved-session reuse, refresh, and resource reads', async (method) => {
    const f = await fixture({registration: false, clientAuth: {method, advertised: false, id: 'registered-client', secret: 'fixture-secret'}})
    const store = memoryOAuthStore()
    let now = Date.now()
    const options = {store, now: () => now}
    vi.stubEnv('RITMO_OAUTH_CLIENT_SECRET', 'fixture-secret')
    try {
      const config = {client_id: 'registered-client', client_secret: {env: 'RITMO_OAUTH_CLIENT_SECRET'}, token_endpoint_auth_method: method}
      const provider = await McpOAuthProvider.create(f.url, config, options)
      await provider.login({openUrl: f.openUrl})
      expect((await McpOAuthProvider.create(f.url, config, options)).status().status).toBe('connected')
      const firstToken = f.accessToken
      now += 65_000
      const client = new McpClient({serverUrl: f.url, auth: {oauth: config}, oauthOptions: options})
      try {
        await client.connect()
        expect((await client.readResourceRaw('ui://oauth-fixture.html'))[0].text).toContain('Authenticated')
        expect(f.accessToken).not.toBe(firstToken)
      } finally { await client.close() }
      expect(f.requests.filter((r) => r.url === '/token')).toHaveLength(2)
      expect(f.requests.filter((r) => r.url.includes('.well-known')).every((r) => !r.headers.authorization && !r.body.includes('fixture-secret'))).toBe(true)
    } finally { vi.unstubAllEnvs() }
  })

  it('does not silently switch client methods when the issuer advertises a conflict', async () => {
    const f = await fixture({registration: false, clientAuth: {method: 'client_secret_basic', advertised: true, id: 'registered-client', secret: 'fixture-secret'}})
    vi.stubEnv('RITMO_OAUTH_CLIENT_SECRET', 'fixture-secret')
    try {
      const provider = await McpOAuthProvider.create(f.url, {client_id: 'registered-client', client_secret: {env: 'RITMO_OAUTH_CLIENT_SECRET'}, token_endpoint_auth_method: 'client_secret_post'}, {store: memoryOAuthStore()})
      const openUrl = vi.fn()
      await expect(provider.login({openUrl})).rejects.toMatchObject({category: 'authentication', message: expect.stringContaining('token_endpoint_auth_method')})
      expect(openUrl).not.toHaveBeenCalled()
      expect(f.requests.some((r) => r.url === '/token')).toBe(false)
    } finally { vi.unstubAllEnvs() }
  })

  it('explains an HTTP 200 client-credential error without server text or automatic method retries', async () => {
    const f = await fixture({registration: false, clientAuth: {method: 'client_secret_post', advertised: false, id: 'registered-client', secret: 'fixture-secret'}})
    vi.stubEnv('RITMO_OAUTH_CLIENT_SECRET', 'fixture-secret')
    try {
      const store = memoryOAuthStore()
      const config = {client_id: 'registered-client', client_secret: {env: 'RITMO_OAUTH_CLIENT_SECRET'}, token_endpoint_auth_method: 'client_secret_basic' as const}
      const provider = await McpOAuthProvider.create(f.url, config, {store})
      await expect(provider.login({openUrl: f.openUrl})).rejects.toMatchObject({category: 'authentication', message: expect.stringContaining('token_endpoint_auth_method')})
      expect(provider.status().status).toBe('disconnected')
      expect((await McpOAuthProvider.create(f.url, config, {store})).status().status).toBe('disconnected')
      expect(f.requests.filter((r) => r.url === '/token')).toHaveLength(1)
    } finally { vi.unstubAllEnvs() }
  })

  it.each(['incorrect_client_credentials', 'invalid_client', 'fixture-secret'])('does not leak server details for HTTP 200 error %s', async (clientError) => {
    const f = await fixture({clientError})
    const provider = await McpOAuthProvider.create(f.url, {}, {store: memoryOAuthStore()})
    const error = await provider.login({openUrl: f.openUrl}).catch((error: unknown) => error)
    expect(error).toMatchObject({category: 'authentication'})
    expect(String(error)).not.toContain('fixture-secret')
    expect(String(error)).not.toContain('private server detail')
    expect(provider.tokens()).toBeUndefined()
  })

  it('keeps additional custom MCP headers off discovery and token requests', async () => {
    const f = await fixture()
    process.env.RITMO_OAUTH_FIXTURE_KEY = 'fixture-extra-key'
    try {
      const connection = await createConnection(f.url, {oauth: {}, headers: {'X-API-Key': {env: 'RITMO_OAUTH_FIXTURE_KEY'}}}, {store: memoryOAuthStore()})
      await connection.oauth!.login({openUrl: f.openUrl, request: connection.fetch})
      expect(f.requests.every((r) => !r.headers['x-api-key'])).toBe(true)
    } finally { delete process.env.RITMO_OAUTH_FIXTURE_KEY }
  })

  it('explains servers that require a pre-registered client', async () => {
    const f = await fixture({registration: false})
    const provider = await McpOAuthProvider.create(f.url, {}, {store: memoryOAuthStore()})
    await expect(provider.login({openUrl: f.openUrl})).rejects.toMatchObject({category: 'authentication', message: expect.stringContaining('client_id')})
  })

  it('cancels a pending browser login and cleans up without storing tokens', async () => {
    const f = await fixture()
    const provider = await McpOAuthProvider.create(f.url, {}, {store: memoryOAuthStore()})
    const controller = new AbortController()
    const phases: string[] = []
    await expect(provider.login({signal: controller.signal, openUrl: async () => { controller.abort() }, onProgress: (phase) => phases.push(phase)})).rejects.toMatchObject({category: 'authentication'})
    expect(phases).toEqual(['waiting'])
    expect(provider.tokens()).toBeUndefined()
  })

  it('fails promptly and without opening a browser in a noninteractive client', async () => {
    const f = await fixture()
    const client = new McpClient({serverUrl: f.url, auth: {oauth: {}}, oauthOptions: {store: memoryOAuthStore()}})
    await expect(client.connect()).rejects.toMatchObject({category: 'authentication', hint: expect.stringContaining('auth mcp --login')})
    expect(f.requests).toHaveLength(0)
  })

  it('rejects denied and forged callbacks and releases the callback port', async () => {
    for (const options of [{denied: true}, {invalidState: true}]) {
      const f = await fixture(options)
      const provider = await McpOAuthProvider.create(f.url, {}, {store: memoryOAuthStore()})
      const phases: string[] = []
      await expect(provider.login({openUrl: f.openUrl, timeoutMs: 350, onProgress: (phase) => phases.push(phase)})).rejects.toMatchObject({category: 'authentication'})
      expect(phases).toEqual(['waiting'])
      expect(provider.tokens()).toBeUndefined()
      expect(f.requests.some((r) => r.url === '/token')).toBe(false)
    }
  })

  it('binds tokens to endpoint, account, and client and clears only the selected session', async () => {
    const f = await fixture()
    const store = memoryOAuthStore()
    const provider = await McpOAuthProvider.create(f.url, {}, {store})
    await provider.login({openUrl: f.openUrl})
    for (const [url, config] of [[`${f.url}/other`, {}], [f.url, {account: 'other'}], [f.url, {client_id: 'other'}]] as const) {
      expect((await McpOAuthProvider.create(url, config, {store})).tokens()).toBeUndefined()
    }
    await provider.clear()
    expect((await McpOAuthProvider.create(f.url, {}, {store})).tokens()).toBeUndefined()
  })

  it('does not send refresh credentials when the discovered issuer changes', async () => {
    const f = await fixture()
    const store = memoryOAuthStore()
    let now = Date.now()
    const provider = await McpOAuthProvider.create(f.url, {}, {store, now: () => now})
    await provider.login({openUrl: f.openUrl})
    f.setIssuer('https://unrelated.example')
    now += 65_000
    await expect(provider.ensureFresh()).rejects.toMatchObject({category: 'authentication'})
    expect(f.requests.filter((r) => r.url === '/token')).toHaveLength(1)
  })

  it('invalidates rejected refresh credentials and returns a reconnect instruction', async () => {
    const f = await fixture()
    let now = Date.now()
    const provider = await McpOAuthProvider.create(f.url, {}, {store: memoryOAuthStore(), now: () => now})
    await provider.login({openUrl: f.openUrl})
    now += 65_000; f.rejectRefresh()
    await expect(provider.ensureFresh()).rejects.toMatchObject({category: 'authentication'})
    expect(provider.tokens()).toBeUndefined()
  })
})
