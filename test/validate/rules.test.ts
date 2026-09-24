import {describe, expect, it} from 'vitest'

import type {RawTool} from '../../src/lib/mcp/client.js'
import {ALL_RULES} from '../../src/lib/validate/rules/index.js'
import {
  toolAnnotationsHonest,
  toolAnnotationsPresent,
  toolDescription,
  toolNaming,
  toolOutputSchema,
  toolSecuritySchemes,
  toolTemplateRef,
  toolTitle,
} from '../../src/lib/validate/rules/tools.js'
import {widgetCsp, widgetDomain, widgetHasHtml, widgetMimeType} from '../../src/lib/validate/rules/widgets.js'
import {configScreenshots, serverInstructions, serverResourcesCapability} from '../../src/lib/validate/rules/server.js'
import {runRules, shouldFail} from '../../src/lib/validate/run.js'
import type {Finding, ValidationContext, WidgetTemplate} from '../../src/lib/validate/types.js'

const URI = 'ui://widget/thing-deadbeef.html'

function goodTool(overrides: Partial<RawTool> = {}): RawTool {
  return {
    name: 'thing_list',
    title: 'List things',
    description: 'Use this when the user wants to see their things.',
    inputSchema: {type: 'object', properties: {}},
    outputSchema: {type: 'object', properties: {}},
    annotations: {readOnlyHint: true, destructiveHint: false, openWorldHint: false},
    securitySchemes: [{type: 'noauth'}],
    _meta: {securitySchemes: [{type: 'noauth'}]},
    ...overrides,
  }
}

function goodTemplate(overrides: Partial<WidgetTemplate> = {}): WidgetTemplate {
  return {
    uri: URI,
    referencedBy: ['thing_list'],
    listed: {uri: URI, mimeType: 'text/html;profile=mcp-app'},
    content: {
      uri: URI,
      mimeType: 'text/html;profile=mcp-app',
      text: '<html><body><div>hi</div></body></html>',
      _meta: {ui: {domain: 'https://app.example.com', csp: {connectDomains: [], resourceDomains: []}}},
    },
    ...overrides,
  }
}

function ctx(partial: Partial<ValidationContext> = {}): ValidationContext {
  return {
    serverUrl: 'http://127.0.0.1:1/mcp',
    server: {name: 'x', capabilities: {tools: {}, resources: {}}, instructions: 'Use these tools.'},
    probes: {},
    tools: [goodTool()],
    resources: [],
    templates: new Map(),
    ...partial,
  }
}

function sev(findings: Finding[]) {
  return findings.map((f) => f.severity)
}

describe('tool rules', () => {
  it('annotations-present fails when any of the three hints is missing', () => {
    const c = ctx({tools: [goodTool({annotations: {readOnlyHint: true}})]})
    const f = toolAnnotationsPresent.check(c)
    expect(f).toHaveLength(1)
    expect(f[0].severity).toBe('fail')
    expect(f[0].message).toContain('destructiveHint')
    expect(f[0].message).toContain('openWorldHint')
    expect(toolAnnotationsPresent.check(ctx())).toEqual([])
  })

  it('annotations-honest flags contradictions and suspicious names', () => {
    const contradiction = goodTool({annotations: {readOnlyHint: true, destructiveHint: true, openWorldHint: false}})
    expect(sev(toolAnnotationsHonest.check(ctx({tools: [contradiction]})))).toContain('fail')

    const deleteNotDestructive = goodTool({name: 'thing_delete', annotations: {readOnlyHint: false, destructiveHint: false, openWorldHint: false}})
    const f = toolAnnotationsHonest.check(ctx({tools: [deleteNotDestructive]}))
    expect(sev(f)).toContain('warn')

    const previewNotReadOnly = goodTool({name: 'thing_get_preview', annotations: {readOnlyHint: false, destructiveHint: false, openWorldHint: false}})
    expect(sev(toolAnnotationsHonest.check(ctx({tools: [previewNotReadOnly]})))).toEqual(['info'])
  })

  it('security-schemes warns when absent, info when only in _meta', () => {
    expect(sev(toolSecuritySchemes.check(ctx({tools: [goodTool({securitySchemes: undefined, _meta: {}})]})))).toEqual(['warn'])
    expect(sev(toolSecuritySchemes.check(ctx({tools: [goodTool({securitySchemes: undefined})]})))).toEqual(['info'])
    expect(toolSecuritySchemes.check(ctx())).toEqual([])
  })

  it('output-schema warns when missing and fails when not object', () => {
    expect(sev(toolOutputSchema.check(ctx({tools: [goodTool({outputSchema: undefined})]})))).toEqual(['warn'])
    expect(sev(toolOutputSchema.check(ctx({tools: [goodTool({outputSchema: {type: 'array'}})]})))).toEqual(['fail'])
  })

  it('name rule fails duplicates and warns on long/odd names', () => {
    const f = toolNaming.check(ctx({tools: [goodTool(), goodTool()]}))
    expect(f.some((x) => x.severity === 'fail' && x.message.includes('appears 2 times'))).toBe(true)
    const long = goodTool({name: 'a'.repeat(70)})
    expect(sev(toolNaming.check(ctx({tools: [long]})))).toEqual(['warn'])
    expect(sev(toolNaming.check(ctx({tools: [goodTool({name: 'has space'})]})))).toEqual(['warn'])
  })

  it('title warns when missing (accepts annotations.title)', () => {
    expect(sev(toolTitle.check(ctx({tools: [goodTool({title: undefined})]})))).toEqual(['warn'])
    expect(toolTitle.check(ctx({tools: [goodTool({title: undefined, annotations: {title: 'T', readOnlyHint: true, destructiveHint: false, openWorldHint: false}})]}))).toEqual([])
  })

  it('description fails when empty, info when it lacks "use this when"', () => {
    expect(sev(toolDescription.check(ctx({tools: [goodTool({description: ''})]})))).toEqual(['fail'])
    expect(sev(toolDescription.check(ctx({tools: [goodTool({description: 'Lists all of the things in the account.'})]})))).toEqual(['info'])
    expect(toolDescription.check(ctx())).toEqual([])
  })

  it('widget-template-ref: inline HTML is a fail, alias-only is a warn, disagreement is a fail, unresolvable is a fail', () => {
    const inline = goodTool({_meta: {'openai/outputTemplate': '<div>hi</div>'}})
    expect(toolTemplateRef.check(ctx({tools: [inline]})).some((f) => f.severity === 'fail' && f.message.includes('inline HTML'))).toBe(true)

    const aliasOnly = goodTool({_meta: {'openai/outputTemplate': URI}})
    const t = new Map([[URI, goodTemplate()]])
    const f1 = toolTemplateRef.check(ctx({tools: [aliasOnly], templates: t}))
    expect(sev(f1)).toEqual(['warn'])

    const disagree = goodTool({_meta: {ui: {resourceUri: URI}, 'openai/outputTemplate': 'ui://widget/other.html'}})
    expect(sev(toolTemplateRef.check(ctx({tools: [disagree], templates: t})))).toContain('fail')

    const unresolvable = goodTool({_meta: {ui: {resourceUri: URI}, 'openai/outputTemplate': URI}})
    const bad = new Map([[URI, goodTemplate({content: undefined, readError: 'Resource not found'})]])
    expect(toolTemplateRef.check(ctx({tools: [unresolvable], templates: bad})).some((f) => f.severity === 'fail' && f.message.includes('could not be read'))).toBe(true)

    // fully correct → no findings
    expect(toolTemplateRef.check(ctx({tools: [unresolvable], templates: t}))).toEqual([])
  })
})

describe('widget rules', () => {
  it('mime-type fails on wrong mime, warns on legacy skybridge', () => {
    const wrong = goodTemplate({content: {...goodTemplate().content!, mimeType: 'text/html'}, listed: {uri: URI, mimeType: 'text/html'}})
    expect(sev(widgetMimeType.check(ctx({templates: new Map([[URI, wrong]])})))).toEqual(['fail'])
    const legacy = goodTemplate({content: {...goodTemplate().content!, mimeType: 'text/html+skybridge'}, listed: {uri: URI, mimeType: 'text/html+skybridge'}})
    expect(sev(widgetMimeType.check(ctx({templates: new Map([[URI, legacy]])})))).toEqual(['warn'])
    expect(widgetMimeType.check(ctx({templates: new Map([[URI, goodTemplate()]])}))).toEqual([])
  })

  it('has-html fails on read errors and empty text', () => {
    expect(sev(widgetHasHtml.check(ctx({templates: new Map([[URI, goodTemplate({content: undefined, readError: 'nope'})]])})))).toEqual(['fail'])
    const empty = goodTemplate({content: {uri: URI, mimeType: 'text/html;profile=mcp-app', text: ''}})
    expect(sev(widgetHasHtml.check(ctx({templates: new Map([[URI, empty]])})))).toEqual(['fail'])
  })

  it('domain fails when missing or only legacy key', () => {
    const none = goodTemplate({content: {...goodTemplate().content!, _meta: {ui: {csp: {}}}}})
    expect(sev(widgetDomain.check(ctx({templates: new Map([[URI, none]])})))).toEqual(['fail'])
    const legacy = goodTemplate({content: {...goodTemplate().content!, _meta: {'openai/widgetDomain': 'https://x.example'}}})
    const f = widgetDomain.check(ctx({templates: new Map([[URI, legacy]])}))
    expect(sev(f)).toEqual(['fail'])
    expect(f[0].message).toContain('legacy')
    expect(widgetDomain.check(ctx({templates: new Map([[URI, goodTemplate()]])}))).toEqual([])
  })

  it('csp: legacy-only is a fail, missing with external hosts is a fail, uncovered host is a warn, external script warns', () => {
    const legacyOnly = goodTemplate({content: {...goodTemplate().content!, _meta: {ui: {domain: 'https://a.example'}, 'openai/widgetCSP': {connect_domains: []}}}})
    expect(widgetCsp.check(ctx({templates: new Map([[URI, legacyOnly]])})).some((f) => f.severity === 'fail' && f.message.includes('legacy'))).toBe(true)

    const noCspExternal = goodTemplate({content: {
      uri: URI, mimeType: 'text/html;profile=mcp-app',
      text: '<html><script src="https://cdn.example.net/x.js"></script></html>',
      _meta: {ui: {domain: 'https://a.example'}},
    }})
    const f = widgetCsp.check(ctx({templates: new Map([[URI, noCspExternal]])}))
    expect(f.some((x) => x.severity === 'fail' && x.message.includes('cdn.example.net'))).toBe(true)

    const uncovered = goodTemplate({content: {
      uri: URI, mimeType: 'text/html;profile=mcp-app',
      text: '<html><script>fetch("https://api.other.example/v1")</script></html>',
      _meta: {ui: {domain: 'https://a.example', csp: {connectDomains: ['api.a.example'], resourceDomains: []}}},
    }})
    const f2 = widgetCsp.check(ctx({templates: new Map([[URI, uncovered]])}))
    expect(f2.some((x) => x.severity === 'warn' && x.message.includes('api.other.example'))).toBe(true)

    // own domain and covered domain are fine
    const covered = goodTemplate({content: {
      uri: URI, mimeType: 'text/html;profile=mcp-app',
      text: '<html><script>fetch("https://api.a.example/v1"); fetch("https://a.example/x")</script></html>',
      _meta: {ui: {domain: 'https://a.example', csp: {connectDomains: ['api.a.example'], resourceDomains: []}}},
    }})
    expect(widgetCsp.check(ctx({templates: new Map([[URI, covered]])}))).toEqual([])
  })
})

describe('server + config rules', () => {
  it('instructions warns when absent', () => {
    expect(sev(serverInstructions.check(ctx({server: {capabilities: {}, instructions: undefined}})))).toEqual(['warn'])
    expect(serverInstructions.check(ctx())).toEqual([])
  })

  it('resources-capability fails only when templates are referenced and resources is null', () => {
    const t = new Map([[URI, goodTemplate()]])
    expect(sev(serverResourcesCapability.check(ctx({resources: null, templates: t})))).toEqual(['fail'])
    expect(serverResourcesCapability.check(ctx({resources: null}))).toEqual([])
    expect(serverResourcesCapability.check(ctx({resources: [], templates: t}))).toEqual([])
  })

  it('config/screenshots warns below 3 and is silent without config', () => {
    const base = {version: 1 as const, app: {name: 'a', description: 'b', icon: 'c', screenshots: ['x']}, server: {url: 'http://x'}, simulate: {model: 'm', default_context: {locale: 'en', timezone: 'UTC'}}, tests: [{file: 't.yaml'}]}
    expect(sev(configScreenshots.check(ctx({config: base})))).toEqual(['warn'])
    expect(configScreenshots.check(ctx({config: {...base, app: {...base.app, screenshots: ['1', '2', '3']}}}))).toEqual([])
    expect(configScreenshots.check(ctx())).toEqual([])
  })
})

describe('runRules / shouldFail', () => {
  it('adds a pass finding per clean rule and summarises', () => {
    const report = runRules(ctx({templates: new Map([[URI, goodTemplate()]]), tools: [goodTool({_meta: {securitySchemes: [{type: 'noauth'}], ui: {resourceUri: URI}, 'openai/outputTemplate': URI}})]}), {rules: ALL_RULES})
    expect(report.summary.fail).toBe(0)
    expect(report.summary.pass).toBeGreaterThan(5)
    expect(report.findings.filter((f) => f.severity === 'pass').every((f) => f.target === '*')).toBe(true)
  })

  it('shouldFail respects the threshold', () => {
    const report = runRules(ctx({tools: [goodTool({outputSchema: undefined})]}), {rules: [toolOutputSchema]})
    expect(report.summary.warn).toBe(1)
    expect(shouldFail(report, 'fail')).toBe(false)
    expect(shouldFail(report, 'warn')).toBe(true)
    expect(shouldFail(report, 'never')).toBe(false)
  })

  it('skips rules by id', () => {
    const report = runRules(ctx({tools: [goodTool({outputSchema: undefined})]}), {rules: [toolOutputSchema], skip: ['tool/output-schema']})
    expect(report.findings).toEqual([])
  })

  it('every rule has a unique id and a source', () => {
    const ids = ALL_RULES.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const r of ALL_RULES) expect(r.source).toMatch(/§/)
  })
})
