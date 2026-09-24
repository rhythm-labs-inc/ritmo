import {describe, expect, it} from 'vitest'

import type {SuiteResult} from '../../src/lib/test-runner/results.js'
import {formatCliReport} from '../../src/lib/test-runner/reporters/cli.js'
import {formatJUnitReport, JUNIT_REPORT_VERSION} from '../../src/lib/test-runner/reporters/junit.js'

function makeSuiteResult(overrides: Partial<SuiteResult> = {}): SuiteResult {
  return {
    suiteName: 'My Test Suite',
    filePath: '/test/suite.yaml',
    cases: [],
    durationMs: 1234,
    ...overrides,
  }
}

function passCase(name = 'Test 1'): SuiteResult['cases'][0] {
  return {
    index: 0,
    name,
    userMessage: 'hello',
    outcome: 'pass',
    assertions: [],
    toolsCalled: [],
    assistantResponse: 'hi',
  }
}

function failCase(name = 'Failing test'): SuiteResult['cases'][0] {
  return {
    index: 1,
    name,
    userMessage: 'call a tool',
    outcome: 'fail',
    assertions: [
      {
        type: 'expect_tool',
        passed: false,
        expected: 'my_tool',
        actual: '(none)',
      },
    ],
    toolsCalled: [],
    assistantResponse: '',
  }
}

function errorCase(name = 'Error test'): SuiteResult['cases'][0] {
  return {
    index: 2,
    name,
    userMessage: 'hello',
    outcome: 'error',
    assertions: [],
    errorMessage: 'API rate limit exceeded',
    toolsCalled: [],
    assistantResponse: '',
  }
}

describe('formatCliReport — all-pass suite', () => {
  it('includes suite name and passing tests', () => {
    const result = makeSuiteResult({cases: [passCase('First test'), passCase('Second test')]})
    const report = formatCliReport(result)
    expect(report).toContain('My Test Suite')
    expect(report).toContain('✓ First test')
    expect(report).toContain('✓ Second test')
    expect(report).toContain('2 tests')
    expect(report).toContain('2 passed')
  })

  it('shows duration in ms', () => {
    const result = makeSuiteResult({cases: [passCase()], durationMs: 500})
    const report = formatCliReport(result)
    expect(report).toContain('500ms')
  })
})

describe('formatCliReport — mixed suite', () => {
  it('shows failure reason for failed assertions', () => {
    const result = makeSuiteResult({cases: [passCase(), failCase()]})
    const report = formatCliReport(result)
    expect(report).toContain('✗ Failing test')
    expect(report).toContain('expect_tool')
    expect(report).toContain('my_tool')
    expect(report).toContain('(none)')
    expect(report).toContain('1 passed')
    expect(report).toContain('1 failed')
  })

  it('shows error message for errored tests', () => {
    const result = makeSuiteResult({cases: [passCase(), errorCase()]})
    const report = formatCliReport(result)
    expect(report).toContain('! Error test')
    expect(report).toContain('rate limit')
    expect(report).toContain('1 errored')
  })
})

describe('formatJUnitReport — XML structure', () => {
  it('produces valid XML with testsuite element', () => {
    const result = makeSuiteResult({cases: [passCase()], durationMs: 2000})
    const xml = formatJUnitReport(result)
    expect(xml).toContain('<?xml version="1.0"')
    expect(xml).toContain('<testsuite')
    expect(xml).toContain('name="My Test Suite"')
    expect(xml).toContain('tests="1"')
    expect(xml).toContain('failures="0"')
    expect(xml).toContain('errors="0"')
    expect(xml).toContain(`name="apprhythm.report.version" value="${JUNIT_REPORT_VERSION}"`)
    expect(xml).toContain('</testsuite>')
  })

  it('produces self-closing testcase for passing tests', () => {
    const result = makeSuiteResult({cases: [passCase('Pass test')]})
    const xml = formatJUnitReport(result)
    expect(xml).toContain('<testcase')
    expect(xml).toContain('name="Pass test"')
    expect(xml).toContain('/>')
  })

  it('includes failure element for failed tests', () => {
    const result = makeSuiteResult({cases: [failCase('My failure')]})
    const xml = formatJUnitReport(result)
    expect(xml).toContain('failures="1"')
    expect(xml).toContain('<failure')
    expect(xml).toContain('expect_tool')
    expect(xml).toContain('</failure>')
  })

  it('includes error element for errored tests', () => {
    const result = makeSuiteResult({cases: [errorCase('Runtime error')]})
    const xml = formatJUnitReport(result)
    expect(xml).toContain('errors="1"')
    expect(xml).toContain('<error')
    expect(xml).toContain('rate limit')
    expect(xml).toContain('</error>')
  })

  it('escapes XML special characters', () => {
    const result = makeSuiteResult({
      suiteName: 'Suite <with> "special" & chars',
      cases: [],
    })
    const xml = formatJUnitReport(result)
    expect(xml).toContain('&lt;with&gt;')
    expect(xml).toContain('&quot;special&quot;')
    expect(xml).toContain('&amp;')
    expect(xml).not.toContain('<with>')
  })

  it('all-fail suite has correct counts', () => {
    const result = makeSuiteResult({cases: [failCase('a'), failCase('b')]})
    const xml = formatJUnitReport(result)
    expect(xml).toContain('tests="2"')
    expect(xml).toContain('failures="2"')
  })
})
