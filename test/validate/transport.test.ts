/**
 * RHY-190: transport / deploy smoke (`doctor`, `validate --probe` deep transport).
 */
import {execFile} from 'node:child_process'
import {createServer, type Server as HttpServer} from 'node:http'
import path from 'node:path'
import {promisify} from 'node:util'

import {afterAll, beforeAll, describe, expect, it} from 'vitest'

import {collectTransport, transportFindings} from '../../src/lib/validate/transport.js'
import {compliantSpec, startFixtureServer, WIDGET_URI, type FixtureServer} from '../helpers/fixture-server.js'

const exec = promisify(execFile)
const BIN = path.resolve(__dirname, '../../bin/run.js')

describe('collectTransport + transportFindings', () => {
  let good: FixtureServer
  let bad: HttpServer
  let badUrl: string
  let dark: HttpServer
  let darkUrl: string

  beforeAll(async () => {
    good = await startFixtureServer(compliantSpec())

    // A deliberately sloppy server: GET 405, DELETE 500, foreign origin accepted, big body 500,
    // malformed JSON → stack trace, unknown method → 200 with no error, no CORS headers.
    bad = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const body = Buffer.concat(chunks).toString('utf8')
      if (req.method === 'GET') { res.writeHead(405).end(); return }
      if (req.method === 'DELETE') { res.writeHead(500).end('boom'); return }
      if (req.method === 'OPTIONS') { res.writeHead(200).end(); return }
      if (body.length > 1_000_000) { res.writeHead(500).end('too big'); return }
      let parsed: {id?: unknown; method?: string; params?: {protocolVersion?: string}} | undefined
      try { parsed = JSON.parse(body) } catch {
        res.writeHead(500, {'content-type': 'text/plain'}).end('TypeError: Cannot read properties of undefined\n    at parse (/srv/app/server.js:12:5)')
        return
      }
      res.writeHead(200, {'content-type': 'application/json'})
      if (parsed?.method === 'initialize') {
        res.end(JSON.stringify({jsonrpc: '2.0', id: parsed.id, result: {protocolVersion: parsed.params?.protocolVersion, capabilities: {}, serverInfo: {name: 'bad', version: '0'}}}))
      } else if (parsed?.method === 'tools/list') {
        res.end(JSON.stringify({jsonrpc: '2.0', id: parsed.id, result: {tools: []}}))
      } else {
        // unknown method / tools/call: "succeed" with no error
        res.end(JSON.stringify({jsonrpc: '2.0', id: parsed?.id, result: {}}))
      }
    })
    await new Promise<void>((r) => bad.listen(0, '127.0.0.1', () => r()))
    badUrl = `http://127.0.0.1:${(bad.address() as {port: number}).port}/mcp`

    dark = createServer((_req, res) => { res.writeHead(404).end() })
    await new Promise<void>((r) => dark.listen(0, '127.0.0.1', () => r()))
    darkUrl = `http://127.0.0.1:${(dark.address() as {port: number}).port}/mcp`
  })

  afterAll(async () => {
    await good.close()
    await new Promise<void>((r) => bad.close(() => r()))
    await new Promise<void>((r) => dark.close(() => r()))
  })

  it('compliant fixture server: initialize ok, protocol negotiation ok, templates read, no fails (SDK server quirks are warnings at most)', async () => {
    const p = await collectTransport(good.url, {timeoutMs: 5000, skipBigBody: true})
    expect(p.initialize?.status).toBe(200)
    expect((p.initialize?.body?.result as {serverInfo: {name: string}}).serverInfo.name).toBe('demo-app')
    expect(p.initializeOld?.body?.result).toBeDefined()
    expect(p.toolCount).toBe(2)
    expect(p.templates?.[0].uri).toBe(WIDGET_URI)
    expect(p.templates?.[0].mimeType).toBe('text/html;profile=mcp-app')
    expect(p.templates?.[0].bytes).toBeGreaterThan(10)
    expect(p.templates?.[0].staleUri).toBe('ui://widget/demo-00000000.html')
    expect(p.templates?.[0].staleResolves).toBe(false) // fixture server does not resolve stale digests
    const f = transportFindings(p)
    expect(f.filter((x) => x.severity === 'fail').map((x) => x.rule)).toEqual([]) // SDK stateless server: GET may 405? no — it answers; assert no fails other than none
    expect(f.find((x) => x.rule === 'transport/templates')?.message).toContain('stale digest')
    // unknown method / tool are proper JSON-RPC errors → no error-hygiene fail
    expect(f.some((x) => x.rule === 'transport/error-hygiene' && x.severity === 'fail')).toBe(false)
  })

  it('sloppy server: fails for GET 405, DELETE 5xx, body bounds, error hygiene; warns for origin + CORS + unknown-method', async () => {
    const p = await collectTransport(badUrl, {timeoutMs: 5000})
    const f = transportFindings(p)
    const by = (rule: string) => f.filter((x) => x.rule === rule)
    expect(by('transport/sse-get')[0]?.severity).toBe('fail')
    expect(by('transport/delete')[0]?.severity).toBe('fail')
    expect(by('transport/body-bounds')[0]?.severity).toBe('fail')
    expect(by('transport/error-hygiene').some((x) => x.severity === 'fail' && /stack trace/.test(x.message))).toBe(true)
    expect(by('transport/error-hygiene').some((x) => x.severity === 'warn' && /unknown JSON-RPC method/.test(x.message))).toBe(true)
    expect(by('transport/origin')[0]?.severity).toBe('warn')
    expect(by('transport/cors')[0]?.severity).toBe('warn')
    expect(by('transport/initialize').some((x) => x.message.includes('no server instructions'))).toBe(true)
  })

  it('hammer: no 429 → info; dark: 404 everywhere → pass, live → fail', async () => {
    const p = await collectTransport(good.url, {timeoutMs: 5000, hammer: 5, skipBigBody: true})
    expect(p.hammer?.n).toBe(5)
    expect(transportFindings(p).find((x) => x.rule === 'transport/rate-limit')?.severity).toBe('info')

    const d = await collectTransport(darkUrl, {timeoutMs: 3000, skipBigBody: true})
    expect(transportFindings(d, {expectDark: true})[0]).toMatchObject({rule: 'transport/dark', severity: 'pass'})
    expect(transportFindings(p, {expectDark: true})[0]).toMatchObject({rule: 'transport/dark', severity: 'fail'})
    // a dark endpoint without --expect-dark is a plain initialize failure
    expect(transportFindings(d)[0]).toMatchObject({rule: 'transport/initialize', severity: 'fail'})
  })

  it('CLI: doctor exits 0 on the fixture server, 1 on the sloppy server, --expect-dark works, --json parses; validate --probe includes transport/deep', async () => {
    const ok = await exec('node', [BIN, 'doctor', good.url, '--skip-big-body'])
    expect(ok.stdout).toContain('transport/initialize')
    expect(ok.stdout).toMatch(/0 failed/)

    let code = 0
    let out = ''
    try {
      await exec('node', [BIN, 'doctor', badUrl])
    } catch (e) {
      code = (e as {code: number}).code
      out = (e as {stdout: string}).stdout
    }
    expect(code).toBe(1)
    expect(out).toContain('transport/error-hygiene')

    const darkOk = await exec('node', [BIN, 'doctor', darkUrl, '--expect-dark'])
    expect(darkOk.stdout).toMatch(/transport\/dark\s+✓ 1\s+! 0\s+✗ 0/)

    const j = await exec('node', [BIN, 'doctor', good.url, '--json', '--skip-big-body', '--fail-on', 'never'])
    const rep = JSON.parse(j.stdout) as {toolCount: number; findings: Array<{rule: string}>}
    expect(rep.toolCount).toBe(2)
    expect(rep.findings.some((f) => f.rule === 'transport/templates')).toBe(true)

    const v = await exec('node', [BIN, 'validate', '--server', badUrl, '--json', '--fail-on', 'never'])
    const vrep = JSON.parse(v.stdout) as {findings: Array<{rule: string; severity: string}>}
    expect(vrep.findings.some((f) => f.rule === 'transport/error-hygiene' && f.severity === 'fail')).toBe(true)
    expect(vrep.findings.some((f) => f.rule === 'transport/origin' && f.severity === 'warn')).toBe(true)
  }, 30000)
})
