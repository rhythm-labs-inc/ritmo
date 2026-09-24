import {describe, expect, it} from 'vitest'
import {addHealthObservation, createHealth, resourceObservation, validationHealth} from '../../src/lib/validate/health.js'
import {formatCliReport, formatJsonReport} from '../../src/lib/validate/report.js'
import {runRules, shouldFail} from '../../src/lib/validate/run.js'
import type {ValidationContext} from '../../src/lib/validate/types.js'

const ctx: ValidationContext = {serverUrl: 'https://example.test/mcp', server: {name: 'fixture', version: 'r7'}, probes: {}, tools: [], resources: [], templates: new Map([['ui://widget', {uri: 'ui://widget', referencedBy: ['show'], response: {contents: []}}]]), probeResults: [{tool: 'show', results: [{content: [{type: 'text', text: 'HTTP 200 success'}]}]}]}
describe('observed stage health', () => {
  it('exposes resource failure after tool success identically in CLI, JSON and simulator observations', () => {
    const report = runRules(ctx, {rules: []})
    expect(report.health?.stages['tool-call']).toBe('pass')
    expect(report.health?.stages['resource-response']).toBe('fail')
    expect(report.health?.status).toBe('fail')
    expect(shouldFail(report, 'fail')).toBe(true)
    expect(shouldFail(report, 'never')).toBe(false)
    expect(formatCliReport(report)).toContain('Resource response: fail')
    expect(JSON.parse(formatJsonReport(report)).health).toEqual(report.health)
    const observation = resourceObservation('ui://widget', {contents: []}, 'chatgpt')
    expect(observation).toEqual(report.health?.observations.find(o => o.stage === 'resource-response'))
  })
  it('never promotes local rendering to real-host or first-interaction evidence', () => {
    const health = addHealthObservation(createHealth(ctx.serverUrl, 'r7'), {stage: 'local-render', state: 'pass', template: 'ui://widget', detail: 'Iframe load reported; visual correctness unverified.'})
    expect(health.stages['real-host-render']).toBe('not-tested')
    expect(health.stages['first-interaction']).toBe('not-tested')
    expect(health.revision).toBe('r7')
    expect(health.status).toBe('not-tested')
  })
  it('does not call discovery a successful tool call, and preserves failures across observations', () => {
    expect(validationHealth({...ctx, probeResults: []}).stages['tool-call']).toBe('not-tested')
    let health = createHealth(ctx.serverUrl)
    health = addHealthObservation(health, {stage: 'tool-call', state: 'fail', tool: 'a', detail: 'failed'})
    health = addHealthObservation(health, {stage: 'tool-call', state: 'pass', tool: 'b', detail: 'completed'})
    expect(health.stages['tool-call']).toBe('fail')
    expect(health.revision).toBe('unknown')
  })
})
