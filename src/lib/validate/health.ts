import type {RawResourceResult} from '../mcp/client.js'
import {checkResourceEnvelope} from './resource-envelope.js'
import type {HostProfile, ValidationContext} from './types.js'

export const HEALTH_LABELS = {'tool-call': 'Tool call', 'resource-response': 'Resource response', 'local-render': 'Local render', 'real-host-render': 'Real-host render', 'first-interaction': 'First interaction'} as const
export type HealthStage = keyof typeof HEALTH_LABELS
export type ObservationState = 'pass' | 'fail' | 'not-tested'
export interface HealthObservation {stage: HealthStage; state: ObservationState; tool?: string; template?: string; detail: string}
export interface HealthReport {endpoint: string; revision: string; status: ObservationState; stages: Record<HealthStage, ObservationState>; observations: HealthObservation[]}
export function createHealth(endpoint: string, revision = 'unknown'): HealthReport {
  return {endpoint, revision, status: 'not-tested', stages: Object.fromEntries(Object.keys(HEALTH_LABELS).map(key => [key, 'not-tested'])) as HealthReport['stages'], observations: []}
}
export function addHealthObservation(report: HealthReport, observation: HealthObservation): HealthReport {
  const observations = [...report.observations, observation]
  const aggregate = (states: ObservationState[]): ObservationState => states.includes('fail') ? 'fail' : states.length && states.every(s => s === 'pass') ? 'pass' : 'not-tested'
  const stages = Object.fromEntries(Object.keys(HEALTH_LABELS).map(stage => [stage, aggregate(observations.filter(o => o.stage === stage).map(o => o.state))])) as HealthReport['stages']
  return {...report, observations, stages, status: aggregate(Object.values(stages))}
}
/** Local envelope acceptance against the selected profile, never proof of real-host acceptance.
 * See docs/apps-sdk-contract.md §3: observed compatibility versus protocol guarantees. */
export function resourceObservation(uri: string, response: RawResourceResult | undefined, host: HostProfile, protocolVersion?: string, error?: string): HealthObservation {
  const findings = response ? checkResourceEnvelope(response, {uri, host, protocolVersion}) : []
  const failures = findings.filter(f => f.severity === 'fail')
  const malformed = response && (!Array.isArray(response.contents) || response.contents.length === 0 || 'error' in response || response.resultType === 'input_required')
  return {stage: 'resource-response', template: uri, state: error || malformed || failures.length ? 'fail' : response ? 'pass' : 'not-tested', detail: error ?? (malformed ? 'No usable resource content was returned.' : failures.length ? failures.map(f => `${f.rule}: ${f.message}`).join(' ') : response ? `Envelope checks completed for ${host}; real-host acceptance is untested.` : 'Resource response was not captured.')}
}
export function validationHealth(ctx: ValidationContext): HealthReport {
  let report = createHealth(ctx.serverUrl, ctx.server.version)
  for (const probe of ctx.probeResults ?? []) {
    report = addHealthObservation(report, {stage: 'tool-call', tool: probe.tool, state: probe.error || probe.results.some(r => r.isError) ? 'fail' : probe.results.length ? 'pass' : 'not-tested', detail: probe.error ?? 'Observed tool responses; no render or interaction is inferred.'})
  }
  for (const template of ctx.templates.values()) report = addHealthObservation(report, resourceObservation(template.uri, template.response, ctx.host ?? 'chatgpt', ctx.server.protocolVersion, template.readError))
  return report
}
export function formatHealth(report: HealthReport): string {
  return ['Observed health (local checks)', `Endpoint: ${report.endpoint} · Server revision: ${report.revision}`, ...Object.entries(HEALTH_LABELS).map(([stage, label]) => `  ${label}: ${report.stages[stage as HealthStage]}`), ...report.observations.filter(o => o.state === 'fail').map(o => `  Failed stage: ${o.stage} · ${o.tool ?? o.template ?? 'session'} · ${o.detail}`)].join('\n')
}
