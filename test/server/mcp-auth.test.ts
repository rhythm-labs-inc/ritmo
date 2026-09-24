import {afterEach, expect, it} from 'vitest'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import path from 'node:path'
import Fastify from 'fastify'
import yaml from 'js-yaml'
import {registerMcpAuthRoutes} from '../../src/lib/server/routes/mcp-auth.js'
import {apprhythmConfigSchema} from '../../src/lib/config-schema.js'
import {loadConfig} from '../../src/lib/config-loader.js'
import {saveMcpAuth} from '../../src/lib/mcp/auth-config.js'
import {updateServerUrlText} from '../../src/lib/config-setup.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true}))) })
async function project() {
  const root = await mkdtemp('/tmp/ritmo-auth-ui-'); roots.push(root)
  const config = apprhythmConfigSchema.parse({version: 1, app: {name: 'Fixture', description: 'Synthetic', icon: 'icon.png'}, server: {url: 'https://example.com/mcp'}, simulate: {model: 'fixture', default_context: {locale: 'en', timezone: 'UTC'}}, tests: [{file: 'smoke.yaml'}]})
  await writeFile(path.join(root, 'apprhythm.yaml'), yaml.dump(config))
  return {root, config}
}

it('requires a same-origin local session for authentication changes and exposes references only', async () => {
  const {root} = await project()
  const app = Fastify()
  registerMcpAuthRoutes(app, {root, config: () => loadConfig(root), changed: async () => {}, busy: () => false})
  await app.ready()
  try {
    const state = (await app.inject({url: '/api/mcp-auth', headers: {host: 'localhost'}})).json()
    const payload = {headers: {'X-API-Key': {env: 'MISSING_FIXTURE_KEY'}}}
    expect((await app.inject({method: 'POST', url: '/api/mcp-auth/configure', headers: {host: 'localhost'}, payload})).statusCode).toBe(403)
    const headers = {host: 'localhost', 'x-ritmo-auth-session': state.session}
    expect((await app.inject({method: 'POST', url: '/api/mcp-auth/configure', headers: {...headers, origin: 'https://unrelated.example'}, payload})).statusCode).toBe(403)
    expect((await app.inject({method: 'POST', url: '/api/mcp-auth/configure', headers, payload})).statusCode).toBe(200)
    expect((await loadConfig(root)).server.auth).toEqual(payload)
    const status = (await app.inject({url: '/api/mcp-auth', headers: {host: 'localhost'}})).json()
    expect(status.status.status).toBe('unavailable')
    expect(status.configuration).toEqual(payload)
    expect((await app.inject({method: 'POST', url: '/api/mcp-auth/configure', headers, payload: {headers: {'X-API-Key': 'raw-secret'}}})).statusCode).toBe(400)
    expect(await readFile(path.join(root, 'apprhythm.yaml'), 'utf8')).not.toContain('raw-secret')
  } finally { await app.close() }
})

it('never retargets saved authentication when the endpoint is edited', async () => {
  const {root, config} = await project()
  await saveMcpAuth(root, config.server.url, {oauth: {account: 'fixture'}})
  const original = await readFile(path.join(root, 'apprhythm.yaml'), 'utf8')
  expect((yaml.load(updateServerUrlText(original, 'https://other.example/mcp')) as typeof config).server.auth).toBeUndefined()
  await expect(saveMcpAuth(root, 'https://stale.example/mcp', {})).rejects.toMatchObject({category: 'authentication'})
})

it('configures and reports the installed CLI using an environment reference without storing its value', async () => {
  const {root} = await project()
  const run = promisify(execFile)
  const bin = path.resolve('bin/run.js')
  const env = {...process.env, RITMO_NO_KEYCHAIN: '1', RITMO_CLI_AUTH_FIXTURE: 'fixture-cli-secret'}
  const result = await run(process.execPath, [bin, 'auth', 'mcp', '--header-env', 'X-API-Key=RITMO_CLI_AUTH_FIXTURE', '--json'], {cwd: root, env})
  expect(JSON.parse(result.stdout).headers).toEqual(['X-API-Key'])
  expect(result.stdout + await readFile(path.join(root, 'apprhythm.yaml'), 'utf8')).not.toContain('fixture-cli-secret')
  try {
    await run(process.execPath, [bin, 'mcp', '--list-tools', '--server', 'https://user:fixture-url-secret@example.com/mcp?token=fixture-query-secret'], {cwd: root, env})
    throw new Error('Expected rejection')
  } catch (error) {
    const output = (error as {stdout?: string; stderr?: string}).stdout + (error as {stderr?: string}).stderr
    expect(output).toContain('Credential-bearing')
    expect(output).not.toContain('fixture-url-secret')
    expect(output).not.toContain('fixture-query-secret')
  }
})

it('rejects a pasted Authorization header as a bearer variable without echoing or saving it', async () => {
  const {root} = await project()
  const file = path.join(root, 'apprhythm.yaml')
  const before = await readFile(file, 'utf8')
  const value = 'Authorization: Bearer synthetic-rejected-token'
  try {
    await promisify(execFile)(process.execPath, [path.resolve('bin/run.js'), 'auth', 'mcp', '--bearer-env', value], {cwd: root, env: {...process.env, RITMO_NO_KEYCHAIN: '1'}})
    throw new Error('Expected rejection')
  } catch (error) {
    const result = error as {code: number; stdout: string; stderr: string}
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('environment variable name')
    expect(result.stdout + result.stderr).not.toContain(value)
    expect(result.stdout + result.stderr).not.toContain('synthetic-rejected-token')
    expect(await readFile(file, 'utf8')).toBe(before)
  }
})

it('saves confidential-client method references through the CLI and retains them in browser configuration', async () => {
  const {root} = await project()
  const secret = 'synthetic-client-secret-never-save'
  const env = {...process.env, RITMO_NO_KEYCHAIN: '1', RITMO_CLI_CLIENT_SECRET: secret}
  const result = await promisify(execFile)(process.execPath, [path.resolve('bin/run.js'), 'auth', 'mcp', '--oauth', '--client-id', 'registered-client', '--client-secret-env', 'RITMO_CLI_CLIENT_SECRET', '--token-endpoint-auth-method', 'client_secret_post', '--json'], {cwd: root, env})
  expect(JSON.parse(result.stdout)).toMatchObject({mode: 'oauth', status: 'disconnected'})
  const expected = {oauth: {client_id: 'registered-client', client_secret: {env: 'RITMO_CLI_CLIENT_SECRET'}, token_endpoint_auth_method: 'client_secret_post'}}
  expect((await loadConfig(root)).server.auth).toEqual(expected)
  const app = Fastify()
  registerMcpAuthRoutes(app, {root, config: () => loadConfig(root), changed: async () => {}, busy: () => false})
  try {
    const state = (await app.inject({url: '/api/mcp-auth', headers: {host: 'localhost'}})).json()
    expect(state.configuration).toEqual(expected)
    expect((await app.inject({method: 'POST', url: '/api/mcp-auth/configure', headers: {host: 'localhost', 'x-ritmo-auth-session': state.session}, payload: state.configuration})).statusCode).toBe(200)
    expect((await loadConfig(root)).server.auth).toEqual(expected)
    expect(JSON.stringify(state) + result.stdout + await readFile(path.join(root, 'apprhythm.yaml'), 'utf8')).not.toContain(secret)
  } finally { await app.close() }
})
