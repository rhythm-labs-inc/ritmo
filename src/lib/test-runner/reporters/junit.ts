import type {SuiteResult} from '../results.js'
import {countErrored, countFailed} from '../results.js'

/** Version of AppRhythm-owned JUnit additions. The document remains JUnit XML. */
export const JUNIT_REPORT_VERSION = 1

/**
 * Escape special XML characters in attribute values and text content.
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Generate a JUnit-compatible XML report string from a suite result.
 */
export function formatJUnitReport(suite: SuiteResult): string {
  const failed = countFailed(suite)
  const errored = countErrored(suite)
  const total = suite.cases.length

  const lines: string[] = []
  lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  lines.push(
    `<testsuite name="${escapeXml(suite.suiteName)}" tests="${total}" failures="${failed}" errors="${errored}" time="${(suite.durationMs / 1000).toFixed(3)}">`,
  )
  lines.push('  <properties>')
  lines.push(`    <property name="apprhythm.report.version" value="${JUNIT_REPORT_VERSION}"/>`)
  lines.push('  </properties>')

  for (const tc of suite.cases) {
    const classname = escapeXml(suite.suiteName)
    const name = escapeXml(tc.name)
    // JUnit time per case is not tracked individually — report 0 for now
    const caseAttr = `classname="${classname}" name="${name}" time="0"`

    if (tc.outcome === 'pass') {
      lines.push(`  <testcase ${caseAttr}/>`)
    } else if (tc.outcome === 'error') {
      lines.push(`  <testcase ${caseAttr}>`)
      lines.push(`    <error message="${escapeXml(tc.errorMessage ?? 'Runtime error')}">`)
      lines.push(`      ${escapeXml(tc.errorMessage ?? '')}`)
      lines.push('    </error>')
      lines.push('  </testcase>')
    } else {
      // fail — collect all failed assertion messages
      const failureMessages = tc.assertions
        .filter((a) => !a.passed)
        .map((a) => `[${a.type}]${a.turn ? ` (turn ${a.turn})` : ''} Expected: ${a.expected}\n  Actual: ${a.actual}`)
        .join('\n')

      lines.push(`  <testcase ${caseAttr}>`)
      lines.push(`    <failure message="${escapeXml(failureMessages.split('\n')[0])}">`)
      lines.push(`      ${escapeXml(failureMessages)}`)
      lines.push('    </failure>')
      lines.push('  </testcase>')
    }
  }

  lines.push('</testsuite>')
  return lines.join('\n')
}
