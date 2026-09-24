/**
 * RHY-188: runtime contract checks + static widget-accessible / URI-versioning rules.
 */
import {execFile} from 'node:child_process'
import path from 'node:path'
import {promisify} from 'node:util'

import {afterAll, beforeAll, describe, expect, it} from 'vitest'

import {McpClient} from '../../src/lib/mcp/client.js'
import {evaluateAssertions} from '../../src/lib/test-runner/assertions.js'
import {checkResultContract, validateAgainstSchema} from '../../src/lib/validate/contract.js'
import {collectContext} from '../../src/lib/validate/context.js'
import {contractTemplateUriVersioned, contractWidgetAccessible, toolCallsInHtml} from '../../src/lib/validate/rules/contract.js'
import {ALL_RULES} from '../../src/lib/validate/rules/index.js'
import {runRules} from '../../src/lib/validate/run.js'
import type {ValidationContext, WidgetTemplate} from '../../src/lib/validate/types.js'
import {compliantSpec, startFixtureServer, WIDGET_URI, type FixtureServer} from '../helpers/fixture-server.js'

const exec = promisify(execFile)
const BIN = path.resolve(__dirname, '../../bin/run.js')

describe('validateAgainstSchema (subset)', () => {
  const schema = {
    type: 'object',
    properties: {
      phase: {type: 'string', enum: ['building', 'complete']},
      step: {type: 'integer', minimum: 1},
      cards: {type: 'array', items: {type: 'object', properties: {id: {type: 'string'}}, required: ['id']}, minItems: 1},
      note: {type: ['string', 'null']},
      nested: {$ref: '#/$defs/n'},
    },
    required: ['phase'],
    additionalProperties: false,
    $defs: {n: {type: 'object', properties: {ok: {type: 'boolean'}}, required: ['ok']}},
  }
  it('accepts a conforming payload', () => {
    expect(validateAgainstSchema({phase: 'building', step: 2, cards: [{id: 'a'}], note: null, nested: {ok: true}}, schema)).toEqual([])
  })
  it('reports type, enum, required, additional, items, minItems, $ref errors with paths', () => {
    const errs = validateAgainstSchema({phase: 'nope', step: 0.5, cards: [], extra: 1, nested: {}}, schema)
    expect(errs.join('\n')).toMatch(/\$\.phase: not one of/)
    expect(errs.join('\n')).toMatch(/\$\.step: expected integer/)
    expect(errs.join('\n')).toMatch(/\$\.cards: fewer than 1/)
    expect(errs.join('\n')).toMatch(/unexpected property "extra"/)
    expect(errs.join('\n')).toMatch(/\$\.nested: missing required "ok"/)
    expect(validateAgainstSchema('str', schema)[0]).toMatch(/expected object, got string/)
  })
  it('accepts unknown keywords and oneOf/anyOf/allOf', () => {
    expect(validateAgainstSchema(5, {type: 'number', format: 'whatever', anyOf: [{minimum: 10}, {maximum: 6}]})).toEqual([])
    expect(validateAgainstSchema(8, {oneOf: [{minimum: 10}, {maximum: 6}]})[0]).toMatch(/matches none of oneOf/)
    expect(validateAgainstSchema(8, {allOf: [{type: 'number'}, {maximum: 6}]})[0]).toMatch(/above maximum/)
  })
})

describe('checkResultContract', () => {
  const tool = {name: 't', outputSchema: {type: 'object', properties: {phase: {type: 'string'}}, required: ['phase']}}
  it('clean result → no findings', () => {
    expect(checkResultContract(tool, {content: [{type: 'text', text: 'ok'}], structuredContent: {phase: 'x'}, _meta: {rhythmSessionToken: 'abcdefghijklmn'}, isError: false})).toEqual([])
  })
  it('schema mismatch → warn; schema without structuredContent → warn; structuredContent without schema → warn', () => {
    const f1 = checkResultContract(tool, {content: [], structuredContent: {nope: 1}, isError: false})
    expect(f1.map((f) => f.rule)).toEqual(['contract/output-schema'])
    expect(f1[0].message).toContain('missing required "phase"')
    const f2 = checkResultContract(tool, {content: [{type: 'text', text: 'x'}], isError: false})
    expect(f2.map((f) => f.rule)).toEqual(['contract/structured-content'])
    const f3 = checkResultContract({name: 't'}, {content: [], structuredContent: {a: 1}, isError: false})
    expect(f3.map((f) => f.rule)).toEqual(['contract/structured-content'])
    // isError results are not penalised for missing structuredContent
    expect(checkResultContract(tool, {content: [{type: 'text', text: 'boom'}], isError: true})).toEqual([])
  })
  it('meta-leak: a _meta value appearing in content or structuredContent is a fail; short non-secret values are ignored', () => {
    const leakContent = checkResultContract({name: 't'}, {content: [{type: 'text', text: 'your token is abcdefghijklmn'}], _meta: {rhythmSessionToken: 'abcdefghijklmn'}, isError: false})
    expect(leakContent[0].rule).toBe('contract/meta-leak')
    expect(leakContent[0].severity).toBe('fail')
    const leakStructured = checkResultContract({name: 't'}, {content: [], structuredContent: {token: 'abcdefghijklmn'}, _meta: {nested: {sessionToken: 'abcdefghijklmn'}}, isError: false})
    expect(leakStructured.find((f) => f.rule === 'contract/meta-leak')?.message).toContain('nested.sessionToken')
    // secret-looking key leaks even when short
    expect(checkResultContract({name: 't'}, {content: [{type: 'text', text: 'pw: abc'}], _meta: {password: 'abc'}, isError: false})[0].rule).toBe('contract/meta-leak')
    // benign short values / different values don't
    expect(checkResultContract({name: 't'}, {content: [{type: 'text', text: 'phase: complete'}], _meta: {phase: 'complete', other: 'zzzzzzzzzz'}, isError: false})).toEqual([])
  })
})

describe('static contract rules', () => {
  const tmpl = (html: string): WidgetTemplate => ({uri: WIDGET_URI, referencedBy: ['demo_list_items'], content: {uri: WIDGET_URI, mimeType: 'text/html;profile=mcp-app', text: html}})
  const ctx = (templates: WidgetTemplate[], tools = compliantSpec().tools!): ValidationContext => ({
    serverUrl: 'x', server: {capabilities: {}}, probes: {}, tools: tools as never, resources: [], templates: new Map(templates.map((t) => [t.uri, t])),
  })

  it('toolCallsInHtml finds callTool literals and raw tools/call payloads', () => {
    expect(toolCallsInHtml(`api().callTool("save_card", {}); window.openai.callTool('preview'); postMessage({method:'tools/call', params:{name:'connect'}})`).sort()).toEqual(['connect', 'preview', 'save_card'])
  })

  it('widget-accessible-coverage: fail when the widget calls a tool not marked accessible; warn for unknown tools; info for stale flags', () => {
    // demo_list_items is widgetAccessible; demo_create_item is not
    const f = contractWidgetAccessible.check(ctx([tmpl(`callTool("demo_create_item"); callTool("ghost")`)]))
    expect(f.find((x) => x.target === 'demo_create_item')?.severity).toBe('fail')
    expect(f.find((x) => x.message.includes('"ghost"'))?.severity).toBe('warn')
    expect(f.find((x) => x.target === 'demo_list_items')?.severity).toBe('info') // accessible but never called
    expect(contractWidgetAccessible.check(ctx([tmpl(`callTool("demo_list_items")`)]))).toEqual([])
  })

  it('template-uri-versioned: warns on unversioned URIs referenced by tools', () => {
    expect(contractTemplateUriVersioned.check(ctx([tmpl('<html/>')]))).toEqual([]) // demo-abc12345 has a digest
    const plain = {...tmpl('<html/>'), uri: 'ui://widget/plain.html'}
    expect(contractTemplateUriVersioned.check(ctx([plain]))[0].severity).toBe('warn')
    const v2 = {...tmpl('<html/>'), uri: 'ui://widget/plain-v2.html'}
    expect(contractTemplateUriVersioned.check(ctx([v2]))).toEqual([])
    const unreferenced = {...plain, referencedBy: []}
    expect(contractTemplateUriVersioned.check(ctx([unreferenced]))).toEqual([])
  })
})

describe('assert_contract assertion', () => {
  const base = {toolsCalled: ['t'], toolArgs: {}, assistantResponse: 'x'}
  const warnFinding = {rule: 'contract/output-schema', severity: 'warn' as const, target: 't', message: 'm'}
  const failFinding = {rule: 'contract/meta-leak', severity: 'fail' as const, target: 't', message: 'leak'}
  it('clean fails on any finding; no-fail only on fail-level', () => {
    const trace = [{toolName: 't', status: 'success' as const, latencyMs: 1, contract: [warnFinding]}]
    expect(evaluateAssertions({assert_contract: 'clean'}, {...base, trace})[0].passed).toBe(false)
    expect(evaluateAssertions({assert_contract: 'no-fail'}, {...base, trace})[0].passed).toBe(true)
    const trace2 = [{toolName: 't', status: 'success' as const, latencyMs: 1, contract: [failFinding]}]
    const r = evaluateAssertions({assert_contract: 'no-fail'}, {...base, trace: trace2})[0]
    expect(r.passed).toBe(false)
    expect(r.actual).toContain('contract/meta-leak')
    expect(evaluateAssertions({assert_contract: 'clean'}, {...base, trace: []})[0].passed).toBe(true)
  })
})

describe('validate --probe-tools and mcp --call contract output (fixture server)', () => {
  let leaky: FixtureServer
  let counter: FixtureServer
  beforeAll(async () => {
    // Leaks the session token into content; structuredContent violates outputSchema
    leaky = await startFixtureServer({
      ...compliantSpec(),
      onCallTool: (name) => ({
        content: [{type: 'text', text: `token=SECRET-TOKEN-123 for ${name}`}],
        structuredContent: {items: 'not-an-array'},
        _meta: {sessionToken: 'SECRET-TOKEN-123'},
      }),
    })
    // readOnly tool whose result changes per call
    let n = 0
    counter = await startFixtureServer({
      ...compliantSpec(),
      onCallTool: (name) => ({content: [{type: 'text', text: `${name} #${++n}`}], structuredContent: {items: [], n}}),
    })
  })
  afterAll(async () => {
    await leaky.close()
    await counter.close()
  })

  it('collectContext(probeTools) calls zero-arg tools (readOnly twice) and rules report meta-leak / output-schema / read-only-probe', async () => {
    const c1 = new McpClient({serverUrl: leaky.url})
    await c1.connect()
    try {
      const ctx = await collectContext({client: c1, serverUrl: leaky.url, probe: false, probeTools: true})
      // demo_list_items accepts {} (readOnly → 2 calls); demo_create_item requires name → skipped
      expect(ctx.probeResults!.map((p) => [p.tool, p.results.length])).toEqual([['demo_list_items', 2]])
      const report = runRules(ctx, {rules: ALL_RULES})
      const ids = report.findings.filter((f) => f.severity !== 'pass').map((f) => f.rule)
      expect(ids).toContain('contract/meta-leak')
      expect(ids).toContain('contract/output-schema')
      expect(report.findings.find((f) => f.rule === 'contract/meta-leak')?.severity).toBe('fail')
    } finally {
      await c1.close()
    }

    const c2 = new McpClient({serverUrl: counter.url})
    await c2.connect()
    try {
      const ctx = await collectContext({client: c2, serverUrl: counter.url, probe: false, probeTools: true})
      const report = runRules(ctx, {rules: ALL_RULES})
      const ro = report.findings.find((f) => f.rule === 'contract/read-only-probe')
      expect(ro?.severity).toBe('warn')
      expect(ro?.target).toBe('demo_list_items')
    } finally {
      await c2.close()
    }
  })

  it('CLI: validate --probe-tools fails on the leak; mcp --call prints contract findings', async () => {
    let code = 0
    let out: string
    try {
      const r = await exec('node', [BIN, 'validate', '--server', leaky.url, '--no-probe', '--probe-tools'])
      out = r.stdout
    } catch (e) {
      const err = e as {code: number; stdout: string}
      code = err.code
      out = err.stdout
    }
    expect(code).toBe(1)
    expect(out).toContain('contract/meta-leak')

    const call = await exec('node', [BIN, 'mcp', '--server', leaky.url, '--call', 'demo_list_items'])
    expect(call.stdout).toContain('contract:')
    expect(call.stdout).toContain('FAIL contract/meta-leak')
    expect(call.stdout).toContain('WARN contract/output-schema')

    const ok = await exec('node', [BIN, 'mcp', '--server', counter.url, '--call', 'demo_list_items'])
    expect(ok.stdout).toContain('contract: ok')
  })
})
