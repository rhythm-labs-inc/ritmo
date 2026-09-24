/**
 * RHY-187: manifest snapshot + diff + resubmission classifier.
 */
import {execFile} from 'node:child_process'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {promisify} from 'node:util'

import {afterAll, beforeAll, describe, expect, it} from 'vitest'

import {RULES, diffManifests, diffShouldFail, formatDiff, summarizeChanges} from '../../src/lib/manifest/diff.js'
import {type Manifest, manifestFromContext, parseManifest, sortKeys, stableStringify} from '../../src/lib/manifest/snapshot.js'
import {McpClient} from '../../src/lib/mcp/client.js'
import {collectContext} from '../../src/lib/validate/context.js'
import {compliantSpec, startFixtureServer, WIDGET_URI, type FixtureServer, type FixtureServerSpec} from '../helpers/fixture-server.js'

const exec = promisify(execFile)
const BIN = path.resolve(__dirname, '../../bin/run.js')

async function capture(spec: FixtureServerSpec, tag?: string): Promise<{manifest: Manifest; srv: FixtureServer}> {
  const srv = await startFixtureServer(spec)
  const client = new McpClient({serverUrl: srv.url})
  await client.connect()
  try {
    const ctx = await collectContext({client, serverUrl: srv.url, probe: false})
    return {manifest: manifestFromContext(ctx, {capturedAt: '2026-08-17T00:00:00Z', tag}), srv}
  } finally {
    await client.close()
  }
}

describe('snapshot', () => {
  it('captures tools (sorted, keys sorted), resources with sha256 + referencedBy, server info; stableStringify is deterministic', async () => {
    const {manifest, srv} = await capture(compliantSpec(), 'v1')
    try {
      expect(manifest.version).toBe(1)
      expect(manifest.tag).toBe('v1')
      expect(manifest.tools.map((t) => t.name)).toEqual(['demo_create_item', 'demo_list_items'])
      expect(Object.keys(manifest.tools[0].descriptor)).toEqual([...Object.keys(manifest.tools[0].descriptor)].sort())
      expect(manifest.tools[1].descriptor.securitySchemes).toEqual([{type: 'noauth'}])
      const r = manifest.resources[0]
      expect(r.uri).toBe(WIDGET_URI)
      expect(r.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(r.bytes).toBeGreaterThan(10)
      expect(r.listed).toBe(true)
      expect(r.referencedBy).toEqual(['demo_list_items'])
      expect(r.mimeType).toBe('text/html;profile=mcp-app')
      expect(manifest.server.instructions).toContain('demo tools')
      const a = stableStringify(manifest)
      const b = stableStringify(JSON.parse(JSON.stringify(sortKeys(manifest))))
      expect(a).toBe(b)
      expect(parseManifest(a).tools).toHaveLength(2)
      expect(() => parseManifest('{"nope":1}')).toThrow(/not an ritmo manifest/)
    } finally {
      await srv.close()
    }
  })
})

describe('diff classifier', () => {
  it('reviews all tool and linked resource metadata while keeping unknown fields uncertain', () => {
    const before = {version: 1, server: {name: 'fixture', capabilities: {}}, tools: [{name: 'demo', descriptor: {name: 'demo', _meta: {'openai/toolInvocation/invoking': 'Reading'}}}], resources: [{uri: WIDGET_URI, _meta: {ui: {prefersBorder: true}}}]} as unknown as Manifest
    const after = structuredClone(before)
    after.tools[0].descriptor._meta = {'openai/toolInvocation/invoking': 'Loading'}
    after.resources[0]._meta = {ui: {prefersBorder: false}}
    after.tools[0].descriptor.futureExtension = true
    const findings = diffManifests(before, after)
    expect(findings.find(f => f.rule === 'tool/meta.other')?.class).toBe('resubmit')
    expect(findings.find(f => f.rule === 'resource/meta.other')?.class).toBe('resubmit')
    expect(findings.find(f => f.rule === 'tool/other')?.class).toBe('warn')
    expect(findings.filter(f => f.class === 'resubmit').every(f => f.message.includes('Keep published contracts available'))).toBe(true)
  })
  it('no changes → empty; classifies each change with a rule that has a source', async () => {
    const base = compliantSpec()
    const {manifest: a, srv: s1} = await capture(base)
    const {manifest: b, srv: s2} = await capture(base)
    try {
      expect(diffManifests(a, b)).toEqual([])
    } finally {
      await s1.close()
      await s2.close()
    }
    for (const [id, r] of Object.entries(RULES)) {
      expect(r.source, id).toBeTruthy()
    }
  })

  it('tool add/remove/description/annotations/ui meta → resubmit; instructions/outputSchema → resubmit', async () => {
    const before = compliantSpec()
    const after = compliantSpec()
    after.instructions = 'Changed instructions.'
    after.tools = after.tools!.map((t) => ({...t}))
    // description change on tool 0, annotations on tool 1, add ui.resourceUri to tool 1, drop nothing, add a tool
    after.tools[0] = {...after.tools[0], description: 'New description', outputSchema: {type: 'object', properties: {x: {type: 'string'}}}}
    after.tools[1] = {...after.tools[1], annotations: {readOnlyHint: true, destructiveHint: false, openWorldHint: false}, _meta: {...(after.tools[1]._meta as object), ui: {resourceUri: WIDGET_URI}}}
    after.tools.push({name: 'brand_new', inputSchema: {type: 'object'}})
    const {manifest: a, srv: s1} = await capture(before)
    const {manifest: b, srv: s2} = await capture(after)
    try {
      const changes = diffManifests(a, b)
      const byRule = new Map(changes.map((c) => [c.rule, c]))
      expect(byRule.get('server/instructions')?.class).toBe('resubmit')
      expect(byRule.get('tool/description')?.class).toBe('resubmit')
      expect(byRule.get('tool/outputSchema')?.class).toBe('resubmit')
      expect(byRule.get('tool/annotations')?.class).toBe('resubmit')
      expect(byRule.get('tool/meta.ui')?.class).toBe('resubmit')
      expect(byRule.get('tool/meta.ui')?.path).toBe('tools.demo_create_item._meta.ui.resourceUri')
      expect(byRule.get('tool/added')?.class).toBe('resubmit')
      // A new resource referenced by tool 1? no — same URI. Removing: simulate by diffing the other way
      const reverse = diffManifests(b, a)
      expect(reverse.some((c) => c.rule === 'tool/removed')).toBe(true)
      const s = summarizeChanges(changes)
      expect(s.resubmit).toBeGreaterThanOrEqual(4)
      expect(diffShouldFail(changes, 'never')).toBe(false)
      expect(diffShouldFail(changes, 'resubmit')).toBe(true)
      const text = formatDiff(changes, {before: 'a', after: 'b'})
      expect(text).toContain('REQUIRES RESUBMISSION')
      expect(text).toContain('Keep published contracts available')
      expect(text).toContain('tool/meta.ui')
    } finally {
      await s1.close()
      await s2.close()
    }
  })

  it('template bytes changed under the same URI → warn; changed under a versioned new URI → resource/added + review note; csp/domain → resubmit', async () => {
    const before = compliantSpec()
    const sameUri = compliantSpec()
    sameUri.resources![0].text = '<html><body>v2</body></html>'
    const newUri = compliantSpec()
    newUri.resources![0] = {...newUri.resources![0], uri: 'ui://widget/demo-ffffffff.html', text: '<html><body>v2</body></html>'}
    newUri.tools![0]._meta = {...(newUri.tools![0]._meta as object), ui: {resourceUri: 'ui://widget/demo-ffffffff.html', visibility: ['model', 'app']}, 'openai/outputTemplate': 'ui://widget/demo-ffffffff.html'}
    const csp = compliantSpec()
    csp.resources![0]._meta = {...(csp.resources![0]._meta as object), ui: {prefersBorder: true, domain: 'https://other.example.com', csp: {connectDomains: ['api.example.com'], resourceDomains: []}}}

    const {manifest: a, srv: s1} = await capture(before)
    const {manifest: b, srv: s2} = await capture(sameUri)
    const {manifest: c, srv: s3} = await capture(newUri)
    const {manifest: d, srv: s4} = await capture(csp)
    try {
      const same = diffManifests(a, b)
      expect(same.map((x) => x.rule)).toEqual(['resource/bytes-same-uri'])
      expect(same[0].class).toBe('warn')
      expect(same[0].message).toContain('up to one hour')
      expect(same[0].message).toContain('compatibility')

      const versioned = diffManifests(a, c)
      const rules = versioned.map((x) => x.rule)
      expect(rules).toContain('resource/added')
      expect(rules).toContain('resource/removed')
      expect(rules).toContain('resource/bytes-new-uri')
      expect(rules).toContain('tool/meta.ui') // the tool now points at the new URI
      expect(versioned.find((x) => x.rule === 'resource/bytes-new-uri')?.class).toBe('resubmit')

      const cspChanges = diffManifests(a, d)
      expect(cspChanges.find((x) => x.rule === 'resource/meta.ui.domain')?.class).toBe('resubmit')
      expect(cspChanges.find((x) => x.rule === 'resource/meta.ui.csp')?.class).toBe('resubmit')
    } finally {
      await Promise.all([s1.close(), s2.close(), s3.close(), s4.close()])
    }
  })
})

describe('CLI: manifest snapshot / diff, and validate manifest/since-snapshot', () => {
  let srv: FixtureServer
  let dir: string
  beforeAll(async () => {
    srv = await startFixtureServer(compliantSpec())
    dir = await mkdtemp(path.join(os.tmpdir(), 'apprhythm-manifest-'))
  })
  afterAll(async () => {
    await srv.close()
    await rm(dir, {recursive: true, force: true})
  })

  it('snapshot writes the file; diff against the same server is empty and exits 0; diff against a changed file exits 1 with --fail-on resubmit', async () => {
    const r = await exec('node', [BIN, 'manifest', 'snapshot', '--server', srv.url, '--tag', 'submitted-test'], {cwd: dir})
    expect(r.stdout).toContain('wrote ritmo.manifest.json')
    const raw = await readFile(path.join(dir, 'ritmo.manifest.json'), 'utf8')
    const m = parseManifest(raw)
    expect(m.tag).toBe('submitted-test')

    const same = await exec('node', [BIN, 'manifest', 'diff', '--server', srv.url], {cwd: dir})
    expect(same.stdout).toContain('No changes.')

    // hand-edit a copy: rename a tool's description → resubmit
    const edited = JSON.parse(raw) as Manifest
    edited.tools[0].descriptor.description = 'edited'
    await writeFile(path.join(dir, 'edited.json'), stableStringify(edited))
    let code = 0
    try {
      await exec('node', [BIN, 'manifest', 'diff', 'ritmo.manifest.json', 'edited.json', '--fail-on', 'resubmit'], {cwd: dir})
    } catch (e) {
      code = (e as {code: number}).code
    }
    expect(code).toBe(1)
    const j = await exec('node', [BIN, 'manifest', 'diff', 'ritmo.manifest.json', 'edited.json', '--json'], {cwd: dir})
    const parsed = JSON.parse(j.stdout) as {summary: {resubmit: number}; changes: Array<{rule: string}>}
    expect(parsed.summary.resubmit).toBe(1)
    expect(parsed.changes[0].rule).toBe('tool/description')

    // validate picks up the snapshot: no changes → rule passes; with edited snapshot in place → warn
    const v0 = await exec('node', [BIN, 'validate', '--server', srv.url, '--json', '--fail-on', 'never', '--no-probe'], {cwd: dir})
    const rep0 = JSON.parse(v0.stdout) as {findings: Array<{rule: string; severity: string}>}
    expect(rep0.findings.find((f) => f.rule === 'manifest/since-snapshot')?.severity).toBe('pass')
    await writeFile(path.join(dir, 'ritmo.manifest.json'), stableStringify(edited))
    const v1 = await exec('node', [BIN, 'validate', '--server', srv.url, '--json', '--fail-on', 'never', '--no-probe'], {cwd: dir})
    const rep1 = JSON.parse(v1.stdout) as {findings: Array<{rule: string; severity: string; message: string}>}
    const f = rep1.findings.find((x) => x.rule === 'manifest/since-snapshot')
    expect(f?.severity).toBe('warn')
    expect(f?.message).toContain('requires resubmission')
  })

  it('diff without a snapshot errors helpfully', async () => {
    const empty = await mkdtemp(path.join(os.tmpdir(), 'apprhythm-nomanifest-'))
    try {
      let stderr = ''
      try {
        await exec('node', [BIN, 'manifest', 'diff', '--server', srv.url], {cwd: empty})
      } catch (e) {
        stderr = (e as {stderr: string}).stderr
      }
      expect(stderr).toContain('manifest snapshot')
    } finally {
      await rm(empty, {recursive: true, force: true})
    }
  })
})
