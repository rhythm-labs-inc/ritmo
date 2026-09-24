import {afterEach, describe, expect, it} from 'vitest'
import {createConnection, authForServer} from '../../src/lib/mcp/connection.js'
import {mcpAuthSchema} from '../../src/lib/mcp/auth-schema.js'
import {McpClient} from '../../src/lib/mcp/client.js'
import {startFixtureServer, type FixtureServer} from '../helpers/fixture-server.js'
import {collectContext} from '../../src/lib/validate/context.js'

const servers: FixtureServer[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => s.close())); delete process.env.RITMO_FIXTURE_KEY })

describe('endpoint authentication', () => {
  it('rejects raw secrets, duplicate and reserved headers, and OAuth Authorization conflicts', () => {
    for (const auth of [
      {headers: {'X-API-Key': 'secret'}},
      {headers: {Cookie: {env: 'KEY'}}},
      {headers: {Authorization: {env: 'KEY'}, authorization: {env: 'KEY'}}},
      {oauth: {}, headers: {AUTHORIZATION: {env: 'KEY'}}},
      {headers: {'X-Key': {env: 'KEY', keychain: 'KEY'}}},
      {oauth: {token_endpoint_auth_method: 'client_secret_post'}},
      {oauth: {client_id: 'registered', token_endpoint_auth_method: 'client_secret_post'}},
      {oauth: {client_id: 'registered', client_secret: {env: 'KEY'}, token_endpoint_auth_method: 'unsupported'}},
    ]) expect(mcpAuthSchema.safeParse(auth).success).toBe(false)
  })

  it('does not carry auth to an overridden endpoint or account', () => {
    const config = {server: {url: 'https://example.com/mcp', auth: {headers: {'X-Key': {env: 'KEY'}}}}}
    expect(authForServer(config, 'https://example.com/mcp')).toEqual(config.server.auth)
    expect(authForServer(config, 'https://example.com/other')).toBeUndefined()
    expect(authForServer(config, 'https://other.example/mcp')).toBeUndefined()
  })

  it('fails before network access for missing header credentials', async () => {
    await expect(createConnection('https://example.com/mcp', {headers: {'X-Key': {env: 'RITMO_FIXTURE_MISSING'}}})).rejects.toMatchObject({category: 'authentication'})
  })

  it('uses headers for handshake, discovery, tool calls, and resources', async () => {
    process.env.RITMO_FIXTURE_KEY = 'fixture-secret'
    const seen: string[] = []
    const server = await startFixtureServer({
      tools: [{name: 'echo', inputSchema: {type: 'object'}}],
      resources: [{uri: 'ui://test.html', text: '<p>fixture</p>'}],
      onHttp(req, res) {
        seen.push(String(req.headers['x-api-key']))
        if (req.headers['x-api-key'] === 'fixture-secret') return false
        res.writeHead(401).end('fixture-secret must never be echoed to the user'); return true
      },
    })
    servers.push(server)
    const client = new McpClient({serverUrl: server.url, auth: {headers: {'X-API-Key': {env: 'RITMO_FIXTURE_KEY'}}}})
    try {
      await client.connect()
      expect((await client.listToolsRaw())[0].name).toBe('echo')
      await client.callTool('echo', {})
      await client.listResourcesRaw()
      expect((await client.readResourceRaw('ui://test.html'))[0].text).toContain('fixture')
      const context = await collectContext({client, serverUrl: server.url, skipBigBody: true})
      expect(context.probes.transport?.initialize?.status).toBe(200)
      expect(seen.every((v) => v === 'fixture-secret')).toBe(true)
    } finally { await client.close() }
  })

  it('removes known credentials from tool results and raw probe evidence even when echoed under harmless keys', async () => {
    process.env.RITMO_FIXTURE_KEY = 'fixture-secret'
    const server = await startFixtureServer({
      tools: [{name: 'echo', inputSchema: {type: 'object'}}],
      onCallTool: () => ({content: [{type: 'text', text: 'fixture-secret'}], structuredContent: {value: 'fixture-secret'}, _meta: {value: 'fixture-secret'}}),
    })
    servers.push(server)
    const client = new McpClient({serverUrl: server.url, auth: {headers: {Authorization: {env: 'RITMO_FIXTURE_KEY', prefix: 'Bearer '}}}})
    try {
      await client.connect()
      expect(JSON.stringify(await client.callTool('echo', {}))).not.toContain('fixture-secret')
      expect(client.sanitize({body: 'fixture-secret', rawPreview: 'Bearer fixture-secret'})).toEqual({body: '[redacted]', rawPreview: '[redacted]'})
    } finally { await client.close() }
  })

  it('never follows credential-bearing redirects, including same-origin paths', async () => {
    process.env.RITMO_FIXTURE_KEY = 'fixture-secret'
    let leaked = false
    const server = await startFixtureServer({onHttp(req, res) {
      if (req.url === '/elsewhere') leaked = true
      res.writeHead(307, {location: '/elsewhere'}).end(); return true
    }})
    servers.push(server)
    const connection = await createConnection(server.url, {headers: {'X-API-Key': {env: 'RITMO_FIXTURE_KEY'}}})
    await expect(connection.fetch(server.url)).rejects.toMatchObject({category: 'authentication'})
    expect(leaked).toBe(false)
  })

  it('reports rejected credentials without echoing the server response', async () => {
    process.env.RITMO_FIXTURE_KEY = 'fixture-secret'
    const server = await startFixtureServer({onHttp(_req, res) { res.writeHead(401).end('fixture-secret'); return true }})
    servers.push(server)
    const client = new McpClient({serverUrl: server.url, auth: {headers: {'X-Key': {env: 'RITMO_FIXTURE_KEY'}}}})
    try { await expect(client.connect()).rejects.toMatchObject({category: 'authentication', message: expect.not.stringContaining('fixture-secret')}) }
    finally { await client.close() }
  })
})
