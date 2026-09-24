import {findingContext, validationProfileLabel} from './finding-context.js'
import {formatHealth} from './health.js'
import {terminalCounts, terminalProse, terminalStatus} from '../cli/ritmo-terminal.js'
import {formatValidationJsonReport, type CliReportOptions} from '../core/reporting.js'
import type {Finding, ValidationReport} from './types.js'

export type {CliReportOptions}

/** Terminal-only adapter. Portable/core and stored report bytes are unchanged. */
export function formatCliReport(report: ValidationReport, options: CliReportOptions = {}): string {
  const lines = [`Validate: ${report.serverUrl}${report.serverName ? ` (${report.serverName})` : ''}`,
    `${report.toolCount} tool${report.toolCount === 1 ? '' : 's'} · ${report.templateCount} widget template${report.templateCount === 1 ? '' : 's'}`, '']
  lines.push(`Profile: ${validationProfileLabel(report.host)}`, 'Requirement scope is shown per finding; submission findings are separate from connection health.', '')
  if (report.policy) lines.push(`Policy: ${report.policy.bundleId}@${report.policy.bundleVersion} (${report.policy.rules.length} rules)`, '')
  const groups = new Map<string, Finding[]>()
  for (const finding of report.findings) groups.set(finding.rule, [...(groups.get(finding.rule) ?? []), finding])
  const visible = [...groups].filter(([, findings]) => !options.quiet || findings.some((f) => f.severity === 'fail' || f.severity === 'warn'))
  lines.push(terminalCounts(visible.map(([name, findings]) => ({name, pass: findings.filter((f) => f.severity === 'pass').length, warn: findings.filter((f) => f.severity === 'warn').length, fail: findings.filter((f) => f.severity === 'fail').length}))), '')
  for (const finding of report.findings) {
    if (finding.severity === 'pass' || (options.quiet && finding.severity === 'info')) continue
    const context = findingContext(finding, report.host)
    const glyph = finding.severity === 'fail' ? '✗' : finding.severity === 'warn' ? '!' : '→'
    lines.push(terminalStatus(finding.severity, `${glyph} ${finding.rule} [${finding.severity.toUpperCase()}]`), `  Target: ${finding.target}`, `  Received: ${finding.message}`, `  Scope: ${context.scope}`, `  Artifact: ${context.artifact}`, `  Source: ${context.reference}`)
    if (finding.severity === 'fail' || finding.severity === 'warn') {
      lines.push(`  Location: ${context.artifact.startsWith('local') ? 'selected project configuration' : report.serverUrl} · ${finding.rule} (source file/line unavailable)`,
        `  Expected: ${finding.hint ?? `satisfy rule ${finding.rule}; this finding supplies no more specific expectation.`}`,
        `  Impact: ${finding.severity === 'fail' ? 'this check failed and remains unresolved.' : 'this warning needs review before relying on the result.'}`)
    }
    lines.push('')
  }
  lines.push(`${report.summary.fail} failed · ${report.summary.warn} warnings · ${report.summary.info} info · ${report.summary.pass} passed`)
  if (report.health) lines.push('', formatHealth(report.health))
  return terminalProse(lines.join('\n'))
}

export function formatJsonReport(report: ValidationReport): string { return formatValidationJsonReport(report) }

export function formatMatrixReport(reports: ValidationReport[], options: CliReportOptions = {}): string {
  // Stacked host groups remain readable at narrow widths without losing columns.
  return 'Validate (all hosts)\n\n' + reports.map((report) => `[${report.host ?? 'chatgpt'}]\n${formatCliReport(report, options)}`).join('\n\n')
}
