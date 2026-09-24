/**
 * RHY-73: portal-enforced rules (transport probes + submission config) and `package`.
 */
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {createServer, type Server as HttpServer} from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'

import {afterAll, beforeAll, describe, expect, it} from 'vitest'
import yaml from 'js-yaml'

import type {AppRhythmConfig} from '../../src/lib/config-schema.js'
import {apprhythmConfigSchema} from '../../src/lib/config-schema.js'
import {McpClient} from '../../src/lib/mcp/client.js'
import {buildSubmissionPackage} from '../../src/lib/package/build.js'
import {collectContext, httpProbe} from '../../src/lib/validate/context.js'
import {
  pngDimensions,
  submissionIcon,
  submissionJustifications,
  submissionListing,
  submissionAvailability,
  submissionAttestations,
  submissionReleaseNotes,
  submissionShowcase,
  submissionSkills,
  submissionTestCases,
  transportChallenge,
  transportSseGet,
} from '../../src/lib/validate/rules/submission.js'
import {ALL_RULES} from '../../src/lib/validate/rules/index.js'
import {runRules} from '../../src/lib/validate/run.js'
import type {ValidationContext} from '../../src/lib/validate/types.js'
import {evaluateAssertions} from '../../src/lib/test-runner/assertions.js'
import {compliantSpec, startFixtureServer} from '../helpers/fixture-server.js'

const exec = promisify(execFile)
const BIN = path.resolve(__dirname, '../../bin/run.js')

function fullConfig(overrides: Partial<AppRhythmConfig> = {}): AppRhythmConfig {
  const base = {
    version: 1 as const,
    app: {
      name: 'Demo Tuner',
      subtitle: 'Tune the demo',
      description: 'A description long enough to satisfy the short-description info rule easily.',
      icon: './icon.png',
      screenshots: ['a', 'b', 'c'],
      privacy_policy_url: 'https://example.com/privacy',
      company_url: 'https://example.com',
      terms_url: 'https://example.com/terms',
    },
    server: {url: 'http://127.0.0.1:1/mcp'},
    simulate: {model: 'gpt-4o-mini', default_context: {locale: 'en-US', timezone: 'UTC'}},
    tests: [{file: 't.yaml'}],
    submission: {
      showcase_prompts: ['Tune my demo', 'Show demo items'],
      test_cases: Array.from({length: 5}, (_, i) => ({scenario: `s${i}`, prompt: `p${i}`, tools: ['demo_list_items'], expected: 'a list'})),
      negative_test_cases: Array.from({length: 3}, (_, i) => ({scenario: `n${i}`, prompt: `q${i}`, rationale: 'unrelated'})),
      tools: {
        demo_list_items: {justifications: {readOnlyHint: 'lists', destructiveHint: 'nothing', openWorldHint: 'local'}},
        demo_create_item: {justifications: {readOnlyHint: 'writes', destructiveHint: 'nothing', openWorldHint: 'local'}},
      },
      skills: [],
      country_availability: ['CA'],
      policy_attestations: {confirmed: true, confirmed_by: 'Test owner', confirmed_at: '2026-08-27T00:00:00Z'},
      release_notes: {
        kind: 'initial',
        summary: 'Initial demo submission.',
        changes: 'Initial release.',
        reviewer_notes: 'No credentials needed.',
      },
    },
  }
  return apprhythmConfigSchema.parse({...base, ...overrides})
}

function ctx(partial: Partial<ValidationContext> = {}): ValidationContext {
  return {
    serverUrl: 'http://127.0.0.1:1/mcp',
    server: {capabilities: {}, instructions: 'x'},
    probes: {},
    tools: compliantSpec().tools as never,
    resources: [],
    templates: new Map(),
    config: fullConfig(),
    ...partial,
  }
}

const sev = (f: {severity: string}[]) => f.map((x) => x.severity)

describe('config schema: submission section', () => {
  it('accepts the full shape and defaults arrays', () => {
    const c = apprhythmConfigSchema.parse({...fullConfig(), submission: {}})
    expect(c.submission?.test_cases).toEqual([])
    expect(c.submission?.tools).toEqual({})
    expect(c.submission?.skills).toEqual([])
    expect(c.submission?.country_availability).toEqual([])
  })
  it('rejects non-https privacy URL and unknown keys', () => {
    expect(apprhythmConfigSchema.safeParse({...fullConfig(), app: {...fullConfig().app, privacy_policy_url: 'http://x.com'}}).success).toBe(false)
    expect(apprhythmConfigSchema.safeParse({...fullConfig(), submission: {bogus: 1}}).success).toBe(false)
    expect(apprhythmConfigSchema.safeParse({...fullConfig(), submission: {...fullConfig().submission!, country_availability: ['Canada']}}).success).toBe(false)
  })
})

describe('submission/* rules', () => {
  it('listing: name/subtitle length, missing privacy URL', () => {
    expect(submissionListing.check(ctx())).toEqual([])
    const long = fullConfig()
    long.app.name = 'x'.repeat(31)
    long.app.subtitle = 'y'.repeat(31)
    delete (long.app as {privacy_policy_url?: string}).privacy_policy_url
    delete (long.app as {terms_url?: string}).terms_url
    const f = submissionListing.check(ctx({config: long}))
    expect(f.filter((x) => x.severity === 'fail').map((x) => x.target).sort()).toEqual(['app.name', 'app.privacy_policy_url', 'app.subtitle', 'app.terms_url'])
    const noSub = fullConfig()
    delete (noSub.app as {subtitle?: string}).subtitle
    expect(sev(submissionListing.check(ctx({config: noSub})))).toEqual(['warn'])
  })

  it('test-cases: minimums, unknown tool refs, extra-slot info', () => {
    expect(submissionTestCases.check(ctx())).toEqual([])
    const few = fullConfig()
    few.submission!.test_cases = few.submission!.test_cases.slice(0, 2)
    few.submission!.negative_test_cases = []
    expect(sev(submissionTestCases.check(ctx({config: few})))).toEqual(['fail', 'fail'])
    const badTool = fullConfig()
    badTool.submission!.test_cases[0].tools = ['nope']
    expect(submissionTestCases.check(ctx({config: badTool})).some((x) => x.severity === 'fail' && x.message.includes('"nope"'))).toBe(true)
    const many = fullConfig()
    many.submission!.test_cases.push({scenario: 'x', prompt: 'y', tools: ['demo_list_items'], expected: 'z'})
    expect(sev(submissionTestCases.check(ctx({config: many})))).toEqual(['info'])
  })

  it('showcase: none = warn, > 3 = fail', () => {
    expect(submissionShowcase.check(ctx())).toEqual([])
    const none = fullConfig(); none.submission!.showcase_prompts = []
    expect(sev(submissionShowcase.check(ctx({config: none})))).toEqual(['warn'])
    const many = fullConfig(); many.submission!.showcase_prompts = ['1', '2', '3', '4']
    expect(sev(submissionShowcase.check(ctx({config: many})))).toEqual(['fail'])
  })

  it('justifications: warn per tool per missing annotation; info for stale entries', () => {
    expect(submissionJustifications.check(ctx())).toEqual([])
    const partial = fullConfig()
    partial.submission!.tools = {demo_list_items: {justifications: {readOnlyHint: 'lists'}}, ghost: {}}
    const f = submissionJustifications.check(ctx({config: partial}))
    expect(f.find((x) => x.target === 'demo_list_items')?.message).toContain('destructiveHint, openWorldHint')
    expect(f.find((x) => x.target === 'demo_create_item')?.severity).toBe('warn')
    expect(f.find((x) => x.target === 'ghost')?.severity).toBe('info')
  })

  it('icon: missing file warns; PNG header parsed', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'apprhythm-icon-'))
    try {
      // minimal PNG header: signature + IHDR length/type + width/height
      const png = Buffer.alloc(33)
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0)
      png.writeUInt32BE(13, 8); png.write('IHDR', 12); png.writeUInt32BE(1024, 16); png.writeUInt32BE(512, 20)
      const p = path.join(dir, 'icon.png')
      await writeFile(p, png)
      expect(pngDimensions(p)).toEqual({width: 1024, height: 512})
      const cfg = fullConfig(); cfg.app.icon = p
      const f = submissionIcon.check(ctx({config: cfg}))
      expect(f[0].message).toContain('1024×512')
      cfg.app.icon = path.join(dir, 'missing.png')
      expect(submissionIcon.check(ctx({config: cfg}))[0].message).toContain('not found')
    } finally {
      await rm(dir, {recursive: true, force: true})
    }
  })
})

describe('submission review-surface fields', () => {
  it('checks local skill trees and calls out MCP-import snapshot uncertainty', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'apprhythm-skill-'))
    try {
      await writeFile(path.join(dir, 'SKILL.md'), '# Test skill\n')
      const cfg = fullConfig()
      cfg.submission!.skills = [{name: 'bundle', path: dir, delivery: 'bundle'}, {name: 'imported', path: dir, delivery: 'mcp-import'}]
      const findings = submissionSkills.check(ctx({config: cfg}))
      expect(findings).toHaveLength(1)
      expect(findings[0]).toMatchObject({severity: 'info', target: 'imported'})

      cfg.submission!.skills = [{name: 'missing', path: path.join(dir, 'missing'), delivery: 'bundle'}]
      expect(submissionSkills.check(ctx({config: cfg}))[0]).toMatchObject({severity: 'fail', target: 'submission.skills.missing.path'})
    } finally {
      await rm(dir, {recursive: true, force: true})
    }
  })

  it('requires availability, human attestation, and release notes without claiming to verify policy', () => {
    const cfg = fullConfig()
    cfg.submission!.country_availability = []
    delete (cfg.submission as {policy_attestations?: unknown}).policy_attestations
    delete (cfg.submission as {release_notes?: unknown}).release_notes

    expect(submissionAvailability.check(ctx({config: cfg}))[0]).toMatchObject({severity: 'warn', target: 'submission.country_availability'})
    expect(submissionAttestations.check(ctx({config: cfg}))[0].hint).toContain('does not certify policy compliance')
    expect(submissionReleaseNotes.check(ctx({config: cfg}))[0]).toMatchObject({severity: 'warn', target: 'submission.release_notes'})
  })
})

describe('transport probes', () => {
  let http: HttpServer
  let base: string

  beforeAll(async () => {
    http = createServer((req, res) => {
      if (req.url === '/sse-ok') {
        res.writeHead(200, {'content-type': 'text/event-stream'})
        res.write(': ping\n\n')
        res.end()
      } else if (req.url === '/405') {
        res.writeHead(405).end()
      } else if (req.url === '/.well-known/openai-apps-challenge') {
        res.writeHead(200, {'content-type': 'text/plain'}).end('tok-123')
      } else if (req.url === '/json-challenge') {
        res.writeHead(200, {'content-type': 'application/json'}).end('{"token":"tok-123"}')
      } else {
        res.writeHead(404).end()
      }
    })
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()))
    const port = (http.address() as {port: number}).port
    base = `http://127.0.0.1:${port}`
  })
  afterAll(async () => { await new Promise<void>((r) => http.close(() => r())) })

  it('sse-get: pass on event-stream, fail on 405, warn on connection error', async () => {
    const ok = await httpProbe(`${base}/sse-ok`, {headers: {Accept: 'text/event-stream'}})
    expect(ok.status).toBe(200)
    expect(transportSseGet.check(ctx({probes: {sseGet: ok}}))).toEqual([])

    const nope = await httpProbe(`${base}/405`)
    const f = transportSseGet.check(ctx({probes: {sseGet: nope}}))
    expect(f[0].severity).toBe('fail')
    expect(f[0].message).toContain('405')

    const dead = await httpProbe('http://127.0.0.1:1/', {timeoutMs: 500})
    expect(dead.error).toBeDefined()
    expect(sev(transportSseGet.check(ctx({probes: {sseGet: dead}})))).toEqual(['warn'])
  })

  it('domain-challenge: bare token passes, JSON body fails, 404 fails', async () => {
    const cfg = fullConfig(); cfg.submission!.challenge_token = 'tok-123'
    const good = await httpProbe(`${base}/.well-known/openai-apps-challenge`)
    expect(transportChallenge.check(ctx({config: cfg, probes: {challenge: good}}))).toEqual([])
    const json = await httpProbe(`${base}/json-challenge`)
    expect(transportChallenge.check(ctx({config: cfg, probes: {challenge: json}}))[0].message).toContain('JSON')
    const missing = await httpProbe(`${base}/nowhere`)
    expect(transportChallenge.check(ctx({config: cfg, probes: {challenge: missing}}))[0].message).toContain('404')
  })

  it('collectContext runs the SSE probe against the fixture server and skips challenge without a token', async () => {
    const srv = await startFixtureServer(compliantSpec())
    const client = new McpClient({serverUrl: srv.url})
    try {
      await client.connect()
      const c = await collectContext({client, serverUrl: srv.url})
      expect(c.probes.sseGet).toBeDefined()
      expect(c.probes.challenge).toBeUndefined()
      // The SDK's Streamable HTTP server answers GET with an SSE stream (or 405 in stateless mode) — either way the probe recorded a status
      expect(c.probes.sseGet!.status ?? c.probes.sseGet!.error).toBeDefined()
      const off = await collectContext({client, serverUrl: srv.url, probe: false})
      expect(off.probes).toEqual({})
    } finally {
      await client.close()
      await srv.close()
    }
  })
})

describe('expect_no_tool_call assertion', () => {
  it('passes when no tools were called and fails otherwise', () => {
    const base = {toolArgs: {}, assistantResponse: 'x', trace: []}
    expect(evaluateAssertions({expect_no_tool_call: true}, {...base, toolsCalled: []})[0].passed).toBe(true)
    const r = evaluateAssertions({expect_no_tool_call: true}, {...base, toolsCalled: ['t']})[0]
    expect(r.passed).toBe(false)
    expect(r.actual).toBe('t')
  })
})

describe('package', () => {
  it('buildSubmissionPackage emits listing, test cases, annotations, runnable suite, json', () => {
    const out = buildSubmissionPackage({config: fullConfig(), tools: compliantSpec().tools as never, serverUrl: 'http://x', generatedAt: '2026-08-17T00:00:00Z'})
    const names = out.files.map((f) => f.path)
    expect(names).toEqual(['listing.md', 'test-cases.md', 'annotations.md', 'skills.md', 'global.md', 'release-notes.md', 'submission.json', 'tests/submission.yaml'])
    expect(out.notes).toEqual([])
    const suite = yaml.load(out.files.find((f) => f.path === 'tests/submission.yaml')!.content) as {tests: Array<Record<string, unknown>>}
    expect(suite.tests).toHaveLength(8)
    expect(suite.tests[0].expect_tool).toBe('demo_list_items')
    expect(suite.tests[7].expect_no_tool_call).toBe(true)
    const ann = out.files.find((f) => f.path === 'annotations.md')!.content
    expect(ann).toContain('| demo_list_items | true — lists | false — nothing | false — local |')
    expect(out.files.find((f) => f.path === 'global.md')!.content).toContain('CA')
    expect(out.files.find((f) => f.path === 'release-notes.md')!.content).toContain('Initial demo submission.')
  })

  it('reports gaps in notes when config is thin and server missing', () => {
    const thin = fullConfig({submission: undefined})
    delete (thin.app as {subtitle?: string}).subtitle
    const out = buildSubmissionPackage({config: thin, serverUrl: 'http://x', generatedAt: 'now'})
    expect(out.notes).toContain('app.subtitle missing')
    expect(out.notes).toContain('0/5 positive test cases')
    expect(out.notes.some((n) => n.includes('server unreachable'))).toBe(true)
    expect(out.files.some((f) => f.path === 'tests/submission.yaml')).toBe(false)
  })

  it('CLI: writes files into --out and exits 0; validate picks up submission/* rules', async () => {
    const srv = await startFixtureServer(compliantSpec())
    const dir = await mkdtemp(path.join(os.tmpdir(), 'apprhythm-pkg-'))
    try {
      const cfg = fullConfig(); cfg.server.url = srv.url
      await writeFile(path.join(dir, 'apprhythm.yaml'), yaml.dump(cfg))
      const r = await exec('node', [BIN, 'package', '--out', './sub'], {cwd: dir})
      expect(r.stdout).toContain('wrote sub/listing.md')
      const listing = await readFile(path.join(dir, 'sub/listing.md'), 'utf8')
      expect(listing).toContain('| Name (≤ 30) | Demo Tuner (10) |')

      // validate with this config: submission rules apply; icon missing → warn only
      const v = await exec('node', [BIN, 'validate', '--json', '--fail-on', 'never'], {cwd: dir})
      const report = JSON.parse(v.stdout) as {findings: Array<{rule: string; severity: string}>}
      const ids = new Set(report.findings.map((f) => f.rule))
      expect(ids).toContain('submission/listing')
      expect(ids).toContain('submission/test-cases')
      expect(ids).toContain('transport/sse-get')
      expect(report.findings.find((f) => f.rule === 'submission/icon')?.severity).toBe('warn')
      expect(report.findings.filter((f) => f.severity === 'fail')).toEqual([])
    } finally {
      await rm(dir, {recursive: true, force: true})
      await srv.close()
    }
  })

  it('every rule id is still unique', () => {
    const ids = ALL_RULES.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    const report = runRules(ctx(), {rules: ALL_RULES})
    // ctx() has no templates map, so the only expected failure is the unresolved template ref
    expect([...new Set(report.findings.filter((f) => f.severity === 'fail').map((f) => f.rule))]).toEqual(['tool/widget-template-ref'])
  })
})
