/**
 * End-to-end: real McpClient → in-process fixture MCP server → collectContext → rules,
 * plus the `validate` command as a child process.
 */
import {execFile} from 'node:child_process'
import path from 'node:path'
import {promisify} from 'node:util'

import {afterAll, beforeAll, describe, expect, it} from 'vitest'

import {McpClient} from '../../src/lib/mcp/client.js'
import {collectContext} from '../../src/lib/validate/context.js'
import {ALL_RULES} from '../../src/lib/validate/rules/index.js'
import {runRules} from '../../src/lib/validate/run.js'
import {compliantSpec, startFixtureServer, WIDGET_URI, type FixtureServer} from '../helpers/fixture-server.js'

const exec = promisify(execFile)
const BIN = path.resolve(__dirname, '../../bin/run.js')

async function runCli(args: string[]): Promise<{code: number; stdout: string; stderr: string}> {
  try {
    const r = await exec('node', [BIN, ...args], {cwd: path.resolve(__dirname, '../fixtures'), env: {...process.env}, maxBuffer: 4 * 1024 * 1024})
    return {code: 0, stdout: r.stdout, stderr: r.stderr}
  } catch (e) {
    const err = e as {code?: number; stdout?: string; stderr?: string}
    return {code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? ''}
  }
}

describe('validate end-to-end against a fixture MCP server', () => {
  let good: FixtureServer
  let bad: FixtureServer

  beforeAll(async () => {
    good = await startFixtureServer(compliantSpec())
    bad = await startFixtureServer({
      // no instructions, no resources capability, sloppy tools
      resourcesCapability: false,
      tools: [
        {
          name: 'delete_everything',
          description: 'Deletes.',
          inputSchema: {type: 'object'},
          annotations: {readOnlyHint: true},
          _meta: {'openai/outputTemplate': '<div>inline html</div>'},
        },
        {name: 'delete_everything', inputSchema: {type: 'object'}},
      ],
    })
  })

  afterAll(async () => {
    await good.close()
    await bad.close()
  })

  it('collectContext gathers raw tools (incl. top-level securitySchemes), templates via resources/read, and instructions', async () => {
    const client = new McpClient({serverUrl: good.url})
    await client.connect()
    try {
      // probe: false — the SDK's stateless fixture server legitimately warns on CORS/Origin/body bounds (see transport.test.ts)
      const ctx = await collectContext({client, serverUrl: good.url, probe: false})
      expect(ctx.server.instructions).toContain('demo tools')
      expect(ctx.tools).toHaveLength(2)
      expect(ctx.tools[0].securitySchemes).toEqual([{type: 'noauth'}]) // would be stripped by SDK listTools()
      expect(ctx.resources).toHaveLength(1)
      const tmpl = ctx.templates.get(WIDGET_URI)
      expect(tmpl?.referencedBy).toEqual(['demo_list_items'])
      expect(tmpl?.content?.mimeType).toBe('text/html;profile=mcp-app')
      expect(tmpl?.content?.text).toContain('<div id="root">')
      expect(tmpl?.listed).toBeDefined()

      const report = runRules(ctx, {rules: ALL_RULES})
      expect(report.summary.fail).toBe(0)
      expect(report.summary.warn).toBe(0)
    } finally {
      await client.close()
    }
  })

  it('uses resource-list metadata when resources/read returns only the widget bytes', async () => {
    const rhythmWireShape = compliantSpec()
    rhythmWireShape.resources = rhythmWireShape.resources!.map((resource) => ({
      ...resource,
      listedMeta: resource._meta,
      readMeta: null,
    }))
    const srv = await startFixtureServer(rhythmWireShape)
    const client = new McpClient({serverUrl: srv.url})
    await client.connect()
    try {
      const ctx = await collectContext({client, serverUrl: srv.url, probe: false})
      const template = ctx.templates.get(WIDGET_URI)
      expect(template?.listed?._meta).toMatchObject({
        'openai/widgetDescription': 'Shows the demo items list.',
        ui: {domain: 'https://demo.example.com', csp: {connectDomains: [], resourceDomains: []}},
      })
      expect(template?.content?._meta).toBeUndefined()

      const report = runRules(ctx, {rules: ALL_RULES})
      expect(report.findings.filter((finding) => [
        'widget/domain',
        'widget/csp',
        'widget/description',
      ].includes(finding.rule) && finding.severity !== 'pass')).toEqual([])
    } finally {
      await client.close()
      await srv.close()
    }
  })

  it('reports the expected failures for a sloppy server', async () => {
    const client = new McpClient({serverUrl: bad.url})
    await client.connect()
    try {
      const ctx = await collectContext({client, serverUrl: bad.url})
      expect(ctx.resources).toBeNull()
      const report = runRules(ctx, {rules: ALL_RULES})
      const failIds = new Set(report.findings.filter((f) => f.severity === 'fail').map((f) => f.rule))
      expect(failIds).toContain('tool/name')                 // duplicate
      expect(failIds).toContain('tool/annotations-present')  // missing hints
      expect(failIds).toContain('tool/description')          // second tool has none
      expect(failIds).toContain('tool/widget-template-ref')  // inline HTML
      expect(report.findings.some((f) => f.rule === 'server/instructions' && f.severity === 'warn')).toBe(true)
    } finally {
      await client.close()
    }
  })

  it('CLI: exits 0 on the compliant server, prints a summary line', async () => {
    const r = await runCli(['validate', '--server', good.url])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/0 failed/)
    expect(r.stdout).toContain('tool/annotations-present')
  })

  it('CLI: exits 1 on the sloppy server; --fail-on never exits 0; --json is parseable', async () => {
    const r = await runCli(['validate', '--server', bad.url])
    expect(r.code).toBe(1)
    expect(r.stdout).toMatch(/FAIL/)

    const r2 = await runCli(['validate', '--server', bad.url, '--fail-on', 'never'])
    expect(r2.code).toBe(0)

    const r3 = await runCli(['validate', '--server', bad.url, '--json', '--fail-on', 'never'])
    const parsed = JSON.parse(r3.stdout) as {summary: {fail: number}; findings: unknown[]}
    expect(parsed.summary.fail).toBeGreaterThan(0)
    expect(Array.isArray(parsed.findings)).toBe(true)
  })

  it('CLI: --list-rules prints ids without connecting; unknown --skip errors', async () => {
    const r = await runCli(['validate', '--list-rules'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('tool/annotations-present')
    expect(r.stdout).toContain('widget/csp')

    const r2 = await runCli(['validate', '--server', good.url, '--skip', 'nope/nope'])
    expect(r2.code).toBe(1)
    expect(r2.stderr).toContain('Unknown rule id')
  })

  it('CLI: flushes a failing JSON report larger than a pipe buffer before exiting 1', async () => {
    const large = await startFixtureServer({
      tools: Array.from({length: 256}, (_, i) => ({name: `tool_${i}`, inputSchema: {type: 'object'}})),
    })
    try {
      const result = await runCli(['validate', '--server', large.url, '--no-probe', '--json'])
      expect(result.code).toBe(1)
      expect(result.stderr).toBe('')
      const report = JSON.parse(result.stdout) as {summary: {fail: number}; findings: {target: string}[]}
      expect(result.stdout.length).toBeGreaterThan(64 * 1024)
      expect(report.summary.fail).toBeGreaterThan(0)
      expect(report.findings.some((finding) => finding.target === 'tool_255')).toBe(true)
    } finally { await large.close() }
  })

  it('CLI: --fail-on warn fails a server that only has warnings', async () => {
    const warnOnly = await startFixtureServer({
      ...compliantSpec(),
      instructions: undefined, // → server/instructions warn
    })
    try {
      const ok = await runCli(['validate', '--server', warnOnly.url])
      expect(ok.code).toBe(0)
      const strict = await runCli(['validate', '--server', warnOnly.url, '--fail-on', 'warn'])
      expect(strict.code).toBe(1)
    } finally {
      await warnOnly.close()
    }
  })
})
