import {formatUsage} from '../simulate/usage.js'
import {findingContext, validationProfileLabel} from '../validate/finding-context.js'
import {formatHealth} from '../validate/health.js'
import {countErrored, countFailed, countPassed, type SuiteResult} from '../test-runner/results.js'
import type {Finding, Severity, ValidationReport} from '../validate/types.js'

/** Styling is injected by CLI adapters; the core default is portable plain text. */
export interface ReportStyle {
  heading(text: string): string
  muted(text: string): string
  divider(width?: number): string
  hint(text: string): string
  status(severity: Severity, text: string): string
}

export const plainReportStyle: ReportStyle = {
  heading: (text) => text,
  muted: (text) => text,
  divider: (width = 60) => '─'.repeat(width),
  hint: (text) => text,
  status: (_severity, text) => text,
}

export interface CliReportOptions {
  /** Hide `pass` and `info` lines. */
  quiet?: boolean
}

const ICON: Record<Severity, string> = {
  fail: '✗',
  warn: '!',
  info: '·',
  pass: '✓',
}

const LABEL: Record<Severity, string> = {
  fail: 'FAIL',
  warn: 'WARN',
  info: 'info',
  pass: 'ok',
}

/** Render a validation report without requiring a terminal/UI framework. */
export function formatValidationCliReport(
  report: ValidationReport,
  options: CliReportOptions = {},
  style: ReportStyle = plainReportStyle,
): string {
  const lines: string[] = []
  const {summary} = report

  lines.push(style.heading(`Validate: ${report.serverUrl}${report.serverName ? ` (${report.serverName})` : ''}`))
  lines.push(style.muted(`${report.toolCount} tool${report.toolCount === 1 ? '' : 's'} · ${report.templateCount} widget template${report.templateCount === 1 ? '' : 's'}`))
  lines.push(style.muted(`Profile: ${validationProfileLabel(report.host)}`))
  if (report.policy) lines.push(style.muted(`Policy: ${report.policy.bundleId}@${report.policy.bundleVersion} (${report.policy.rules.length} rules)`))
  lines.push(style.divider())

  const byRule = new Map<string, Finding[]>()
  for (const finding of report.findings) {
    const entries = byRule.get(finding.rule) ?? []
    entries.push(finding)
    byRule.set(finding.rule, entries)
  }

  for (const [rule, findings] of byRule) {
    const visible = options.quiet ? findings.filter((finding) => finding.severity === 'fail' || finding.severity === 'warn') : findings
    if (visible.length === 0) continue
    const worst = worstSeverity(findings)
    lines.push(style.status(worst, `${ICON[worst]} ${rule}`))
    for (const finding of visible) {
      if (finding.severity === 'pass') continue
      lines.push(style.status(finding.severity, `    ${LABEL[finding.severity].padEnd(4)} ${finding.target}: ${finding.message}`))
      const context = findingContext(finding, report.host)
      lines.push(`         Scope: ${context.scope} · Artifact: ${context.artifact}`, `         Source: ${context.reference}`)
      if (finding.hint && (finding.severity === 'fail' || finding.severity === 'warn')) {
        lines.push(style.hint(`         → ${finding.hint}`))
      }
    }
  }

  lines.push(style.divider())
  lines.push([
    style.status('fail', `${summary.fail} failed`),
    style.status('warn', `${summary.warn} warning${summary.warn === 1 ? '' : 's'}`),
    style.status('info', `${summary.info} info`),
    style.status('pass', `${summary.pass} passed`),
  ].join(' · '))
  if (report.health) lines.push('', formatHealth(report.health))
  return lines.join('\n')
}

/** Stable JSON serialization used by CLI and non-CLI consumers. */
export function formatValidationJsonReport(report: ValidationReport): string {
  return JSON.stringify(report, null, 2)
}

/** Render a multi-host validation matrix without requiring a terminal/UI framework. */
export function formatValidationMatrixReport(
  reports: ValidationReport[],
  options: CliReportOptions = {},
  style: ReportStyle = plainReportStyle,
): string {
  const lines: string[] = []
  const first = reports[0]
  if (!first) return ''

  lines.push(style.heading(`Validate (all hosts): ${first.serverUrl}${first.serverName ? ` (${first.serverName})` : ''}`))
  lines.push(style.muted(`${first.toolCount} tool${first.toolCount === 1 ? '' : 's'} · ${first.templateCount} widget template${first.templateCount === 1 ? '' : 's'}`))
  const hosts = reports.map((report) => report.host ?? 'chatgpt')
  lines.push(style.divider())
  lines.push(style.muted(`${'rule'.padEnd(40)}${hosts.map((host) => host.padEnd(10)).join('')}`))
  const ruleIds: string[] = []
  const perHost = new Map<string, Map<string, Finding[]>>()
  for (const report of reports) {
    const findingsByRule = new Map<string, Finding[]>()
    for (const finding of report.findings) {
      if (!ruleIds.includes(finding.rule)) ruleIds.push(finding.rule)
      findingsByRule.set(finding.rule, [...(findingsByRule.get(finding.rule) ?? []), finding])
    }
    perHost.set(report.host ?? 'chatgpt', findingsByRule)
  }

  for (const id of ruleIds) {
    const cells = hosts.map((host) => {
      const findings = perHost.get(host)?.get(id)
      if (!findings) return '—'.padEnd(10)
      const severity = worstSeverity(findings)
      return style.status(severity, `${ICON[severity]} ${LABEL[severity]}`.padEnd(10))
    })
    const anyProblem = hosts.some((host) => (perHost.get(host)?.get(id) ?? []).some((finding) => finding.severity === 'fail' || finding.severity === 'warn'))
    if (options.quiet && !anyProblem) continue
    lines.push(`${id.padEnd(40)}${cells.join('')}`)
  }

  lines.push(style.divider())
  lines.push(style.heading('Details (non-pass, per host):'))
  for (const report of reports) {
    const findings = report.findings.filter((finding) => finding.severity !== 'pass' && (!options.quiet || finding.severity === 'fail' || finding.severity === 'warn'))
    if (findings.length === 0) continue
    lines.push(style.muted(`  [${report.host}]`))
    for (const finding of findings) {
      lines.push(style.status(finding.severity, `    ${LABEL[finding.severity].padEnd(4)} ${finding.rule} · ${finding.target}: ${finding.message}`))
      const context = findingContext(finding, report.host)
      lines.push(style.muted(`      Scope: ${context.scope} · Artifact: ${context.artifact}`))
      lines.push(style.muted(`      Source: ${context.reference}`))
      if (finding.hint) lines.push(style.muted(`      Hint: ${finding.hint}`))
    }
  }
  lines.push(style.divider())
  lines.push(reports.map((report) => [
    style.muted(`${report.host}:`),
    style.status('fail', `${report.summary.fail} failed`),
    style.status('warn', `${report.summary.warn} warn`),
    style.status('info', `${report.summary.info} info`),
    style.status('pass', `${report.summary.pass} passed`),
  ].join(' · ')).join('\n'))
  return lines.join('\n')
}

/** Render a test-suite report without requiring a terminal/UI framework. */
export function formatTestCliReport(suite: SuiteResult, style: ReportStyle = plainReportStyle): string {
  const lines: string[] = []
  const passed = countPassed(suite)
  const failed = countFailed(suite)
  const errored = countErrored(suite)
  const total = suite.cases.length

  lines.push(`\n${style.heading(`Test suite: ${suite.suiteName}`)}`)
  lines.push(style.divider())
  for (const testCase of suite.cases) {
    const icon = testCase.outcome === 'pass' ? '✓' : testCase.outcome === 'error' ? '!' : '✗'
    const rate = testCase.passRate !== undefined && testCase.runs ? ` (${Math.round(testCase.passRate * 100)}% of ${testCase.runs.length} runs)` : ''
    const severity: Severity = testCase.outcome === 'pass' ? 'pass' : testCase.outcome === 'error' ? 'warn' : 'fail'
    lines.push(style.status(severity, `  ${icon} ${testCase.name}${rate}`))

    for (const finding of testCase.answerFindings ?? []) lines.push(style.status('warn', `      Source links need review: ${finding.message}`))
    if (testCase.outcome === 'error') {
      lines.push(style.status('warn', `      Runtime error: ${testCase.errorMessage ?? 'unknown error'}`))
    } else if (testCase.outcome === 'fail') {
      for (const assertion of testCase.assertions) {
        if (assertion.passed) continue
        const where = assertion.turn ? ` (turn ${assertion.turn})` : ''
        lines.push(style.status('fail', `      [${assertion.type}]${where} Expected: ${assertion.expected}`))
        lines.push(style.status('fail', `        Actual:   ${assertion.actual}`))
      }
    }
  }

  lines.push(style.divider())
  const parts: string[] = [`${total} test${total === 1 ? '' : 's'}`]
  if (passed > 0) parts.push(style.status('pass', `${passed} passed`))
  if (failed > 0) parts.push(style.status('fail', `${failed} failed`))
  if (errored > 0) parts.push(style.status('warn', `${errored} errored`))
  parts.push(`${suite.durationMs}ms`)
  lines.push(parts.join('  ·  '))
  lines.push('')
  if (suite.usage && suite.usage.requests > 0) lines.push(formatUsage(suite.usage))
  return lines.join('\n')
}

function worstSeverity(findings: Finding[]): Severity {
  if (findings.some((finding) => finding.severity === 'fail')) return 'fail'
  if (findings.some((finding) => finding.severity === 'warn')) return 'warn'
  if (findings.some((finding) => finding.severity === 'info')) return 'info'
  return 'pass'
}
