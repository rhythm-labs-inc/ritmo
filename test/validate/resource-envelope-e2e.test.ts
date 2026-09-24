import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import path from 'node:path'
import {expect, it} from 'vitest'
import {McpClient} from '../../src/lib/mcp/client.js'
import {collectContext} from '../../src/lib/validate/context.js'
import {checkResourceEnvelope} from '../../src/lib/validate/resource-envelope.js'
import {Simulator} from '../../src/lib/server/simulator.js'
import {getSessionState, resetSession} from '../../src/lib/server/session-store.js'
import {apprhythmConfigSchema} from '../../src/lib/config-schema.js'
import {compliantSpec, startFixtureServer, WIDGET_URI} from '../helpers/fixture-server.js'
const exec = promisify(execFile)
it('preserves the envelope and shares exact findings between CLI, collected evidence and simulator', async () => {
  const spec = compliantSpec()
  spec.resources![0].cacheHints = {}
  const server = await startFixtureServer(spec)
  const client = new McpClient({serverUrl: server.url})
  const sim = new Simulator({config: apprhythmConfigSchema.parse({version: 1, app: {name: 'QA', description: 'QA fixture', icon: 'icon.png'}, server: {url: server.url}, simulate: {model: 'fixture', default_context: {locale: 'en-US', timezone: 'UTC'}}, tests: [{file: "tests/smoke.yaml"}]})})
  try {
    await client.connect()
    const context = await collectContext({client, serverUrl: server.url, probe: false})
    const response = context.templates.get(WIDGET_URI)!.response!
    expect(response.contents[0].text).toContain('<')
    expect(response).not.toHaveProperty('ttlMs')
    const expected = checkResourceEnvelope(response, {uri: WIDGET_URI, host: 'chatgpt', protocolVersion: context.server.protocolVersion})
    const {stdout} = await exec(process.execPath, [path.resolve('bin/run.js'), 'validate', '--server', server.url, '--no-probe', '--fail-on', 'never', '--json'])
    const findings = JSON.parse(stdout).findings.filter((f: {severity: string; rule: string}) => f.rule.startsWith('resource/cache-') && f.severity !== 'pass')
    expect(findings).toEqual(expected)
    resetSession()
    await sim.ensureConnected()
    expect(getSessionState().widgetDiagnostics.filter(d => d.method.startsWith('resource/cache-')).map(d => d.detail)).toEqual(expected)
    expect(getSessionState().health?.stages).toEqual(JSON.parse(stdout).health.stages)
    expect(getSessionState().health?.observations).toEqual(JSON.parse(stdout).health.observations)
    sim.setHostOptions({host: 'mcp-apps'})
    expect(getSessionState().widgetDiagnostics.at(-1)?.detail).toMatchObject({rule: 'resource/cache-applicability', severity: 'info'})
    expect(server.calls).toEqual([])
  } finally { await sim.close(); await client.close(); await server.close(); resetSession() }
})
it('retains valid envelope fields and keeps the legacy content reader compatible', async () => {
  const server = await startFixtureServer(compliantSpec()), client = new McpClient({serverUrl: server.url})
  try {
    await client.connect()
    const envelope = await client.readResourceEnvelope(WIDGET_URI)
    expect(envelope).toMatchObject({ttlMs: 0, cacheScope: 'private'})
    expect(await client.readResourceRaw(WIDGET_URI)).toEqual(envelope.contents)
  } finally { await client.close(); await server.close() }
})
