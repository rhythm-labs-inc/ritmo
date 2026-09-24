import {describe, expect, it} from 'vitest'
import {runRules} from '../../src/lib/validate/run.js'
import {toolOutputSchema, toolDescription, toolAnnotationsPresent, toolSecuritySchemes} from '../../src/lib/validate/rules/tools.js'
import {directoryListing, directoryTitleAndHints} from '../../src/lib/validate/rules/directory.js'
import {formatCliReport} from '../../src/lib/validate/report.js'
import {formatValidationCliReport} from '../../src/lib/core/reporting.js'
import type {ValidationContext} from '../../src/lib/validate/types.js'
import {apprhythmConfigSchema} from '../../src/lib/config-schema.js'

const ctx: ValidationContext = {serverUrl: 'https://example.com/mcp', server: {capabilities: {}}, tools: [{name: 'search', inputSchema: {type: 'object'}}], resources: [], templates: new Map(), probes: {}, host: 'mcp-apps'}
describe('acceptance validation findings', () => {
  it.each(['Use this only when the user requests an excerpt.', 'Use this after finding a source identifier.', 'Call this tool if you need the full record.', 'Returns search snippets for discovery; invoke it before reading full content.'])('recognizes usage guidance: %s', description => {
    expect(toolDescription.check({...ctx, tools: [{name: 'search', description}]})).toEqual([])
  })
  it('calls a phrase-pattern miss a heuristic instead of asserting absent guidance', () => {
    const findings = toolDescription.check({...ctx, tools: [{name: 'search', description: 'Searches the available archive and returns excerpts.'}]})
    expect(findings[0].message).toMatch(/heuristic/i)
    expect(findings[0].message).not.toMatch(/does not say/)
  })
  it('does not apply ChatGPT submission requirements to MCP Apps', () => {
    expect(runRules(ctx, {rules: [toolAnnotationsPresent, toolSecuritySchemes]}).findings).toEqual([])
    expect(runRules({...ctx, host: 'chatgpt'}, {rules: [toolAnnotationsPresent, toolSecuritySchemes]}).summary.fail).toBe(1)
  })
  it('labels directory scope and local project findings in both terminal and portable reports', () => {
    const config = apprhythmConfigSchema.parse({version: 1, tests: [{file: 'tests/smoke.yaml'}], app: {name: 'Example', description: 'Test project', icon: 'icon.png'}, server: {url: ctx.serverUrl}, simulate: {model: 'test', default_context: {locale: 'en', timezone: 'UTC'}}})
    const report = runRules({...ctx, config}, {rules: [directoryListing, directoryTitleAndHints]})
    for (const text of [formatCliReport(report), formatValidationCliReport(report)]) {
      expect(text).toContain('Claude directory')
      expect(text).toContain('apprhythm.yaml')
      expect(text).toContain('docs/apps-sdk-contract.md §9')
      expect(text).not.toContain('Location: https://example.com/mcp · directory/listing')
    }
    expect(report.findings.find(f=>f.rule==='directory/listing')?.message).toMatch(/local/i)
  })
})

it('keeps missing-schema portal warnings out of MCP Apps but validates declared schemas', () => {
 expect(toolOutputSchema.check(ctx)).toEqual([])
 expect(toolOutputSchema.check({...ctx, host:'chatgpt'})[0].severity).toBe('warn')
 expect(toolOutputSchema.check({...ctx, tools:[{name:'search',outputSchema:{type:'string'}}]})[0].severity).toBe('fail')
})
