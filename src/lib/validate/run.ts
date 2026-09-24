/**
 * Apply rules to a collected context and produce a report.
 */

import {validationHealth} from './health.js'
import {VALIDATION_REPORT_VERSION, type Finding, type Rule, type Severity, type ValidationContext, type ValidationReport, type ValidationSummary} from './types.js'

export interface RunOptions {
  rules: Rule[]
  /** Rule ids to skip (e.g. from `--skip`). */
  skip?: string[]
}

export function runRules(ctx: ValidationContext, options: RunOptions): ValidationReport {
  const skip = new Set(options.skip ?? [])
  const findings: Finding[] = []

  for (const rule of options.rules) {
    if (skip.has(rule.id)) continue
    if (rule.hosts && !rule.hosts.includes(ctx.host ?? 'chatgpt')) continue
    if (rule.applies && !rule.applies(ctx)) continue
    let ruleFindings: Finding[]
    try {
      ruleFindings = rule.check(ctx)
    } catch (err) {
      ruleFindings = [{
        rule: rule.id,
        severity: 'fail',
        target: '*',
        message: `rule crashed: ${err instanceof Error ? err.message : String(err)}`,
        hint: 'This is a bug in Ritmo, not your server. Please report it with --json output.',
      }]
    }

    if (ruleFindings.length === 0) {
      findings.push({rule: rule.id, severity: 'pass', target: '*', message: rule.description, source: rule.source})
    } else {
      findings.push(...ruleFindings)
    }
  }

  return {
    version: VALIDATION_REPORT_VERSION,
    health: validationHealth(ctx),
    serverUrl: ctx.serverUrl,
    host: ctx.host ?? 'chatgpt',
    serverName: ctx.server.name,
    toolCount: ctx.tools.length,
    templateCount: ctx.templates.size,
    findings,
    summary: summarize(findings),
  }
}

export function summarize(findings: Finding[]): ValidationSummary {
  const s: ValidationSummary = {fail: 0, warn: 0, info: 0, pass: 0}
  for (const f of findings) s[f.severity]++
  return s
}

export type FailOn = 'fail' | 'warn' | 'info' | 'never'

/** Whether the report should produce a non-zero exit code under the given threshold. */
export function shouldFail(report: ValidationReport, failOn: FailOn): boolean {
  const order: Severity[] = ['fail', 'warn', 'info']
  if (failOn === 'never') return false
  if (report.health?.status === 'fail') return true
  const threshold = order.indexOf(failOn)
  return report.findings.some((f) => {
    const idx = order.indexOf(f.severity)
    return idx !== -1 && idx <= threshold
  })
}
