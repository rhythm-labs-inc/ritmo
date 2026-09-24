import {terminalDivider, terminalHeading, terminalStatus, terminalCounts, terminalProse} from '../../cli/ritmo-terminal.js'
import {formatTestCliReport} from '../../core/reporting.js'
import type {SuiteResult} from '../results.js'

/**
 * Render a human-readable CLI test report and return it as a string.
 */
export function formatCliReport(suite: SuiteResult): string {
  const report = formatTestCliReport(suite, {
    heading: terminalHeading,
    muted: (text) => text,
    divider: terminalDivider,
    hint: (text) => text,
    status: terminalStatus,
  })
  const details = suite.cases.filter((item) => item.outcome !== 'pass').map((item) => [
    '', `  Scenario: ${item.name}`, `  Location: ${suite.filePath} · tests[${item.index}] (source line unavailable)`,
    `  Expected: ${item.assertions.filter((a) => !a.passed).map((a) => a.expected).join('; ') || 'test execution completes'}`,
    `  Received: ${item.errorMessage ?? item.assertions.filter((a) => !a.passed).map((a) => a.actual).join('; ')}`,
    '  Impact: this scenario does not establish the expected app behavior.',
  ].join('\n')).join('\n')
  const counts = terminalCounts([{name: suite.suiteName, pass: suite.cases.filter((c) => c.outcome === 'pass').length, warn: suite.cases.filter((c) => c.outcome === 'error').length, fail: suite.cases.filter((c) => c.outcome === 'fail').length}])
  return terminalProse(`${counts}\n${report}${details}`)
}
