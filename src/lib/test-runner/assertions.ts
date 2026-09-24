import type {TraceEvent} from '../simulate/trace.js'
import type {Assertion} from './schema.js'
import type {AssertionResult} from './results.js'

export interface ExecutionArtifacts {
  /** Tool names called during the simulation, in order */
  toolsCalled: string[]
  /** Arguments passed to each tool call, keyed by tool name (last call wins if called multiple times) */
  toolArgs: Record<string, Record<string, unknown>>
  /** The final assistant response text */
  assistantResponse: string
  /** Full per-call trace (request + full result incl. structuredContent/_meta) */
  trace: TraceEvent[]
}

/**
 * Evaluate all assertions for a single test case against the execution artifacts.
 * Returns one AssertionResult per assertion field present in the test case.
 */
export function evaluateAssertions(
  assertions: Assertion,
  artifacts: ExecutionArtifacts,
): AssertionResult[] {
  const results: AssertionResult[] = []

  // expect_tool: assert at least one call to the named tool occurred
  if (assertions.expect_tool !== undefined) {
    const expected = assertions.expect_tool
    const actual = artifacts.toolsCalled.join(', ') || '(none)'
    const passed = artifacts.toolsCalled.includes(expected)
    results.push({
      type: 'expect_tool',
      passed,
      expected,
      actual,
    })
  }

  // expect_no_tool_call: the model must not have invoked any tool
  if (assertions.expect_no_tool_call) {
    results.push({
      type: 'expect_no_tool_call',
      passed: artifacts.toolsCalled.length === 0,
      expected: '(no tool calls)',
      actual: artifacts.toolsCalled.join(', ') || '(none)',
    })
  }

  // assert_contract: no contract/* findings (clean) or none at fail level (no-fail) across this turn's calls
  if (assertions.assert_contract !== undefined) {
    const findings = artifacts.trace.flatMap((ev) => ev.contract ?? [])
    const bad = assertions.assert_contract === 'clean' ? findings : findings.filter((f) => f.severity === 'fail')
    results.push({
      type: 'assert_contract',
      passed: bad.length === 0,
      expected: assertions.assert_contract === 'clean' ? '(no contract findings)' : '(no contract failures)',
      actual: bad.length === 0 ? '(none)' : bad.map((f) => `${f.rule} on ${f.target}: ${f.message}`).join('; '),
    })
  }

  // tools_called: every listed tool was called; [] means nothing may be called
  if (assertions.tools_called !== undefined) {
    const expected = assertions.tools_called
    const called = new Set(artifacts.toolsCalled)
    const passed = expected.length === 0 ? artifacts.toolsCalled.length === 0 : expected.every((t) => called.has(t))
    results.push({
      type: 'tools_called',
      passed,
      expected: expected.length === 0 ? '(no tool calls)' : expected.join(', '),
      actual: artifacts.toolsCalled.join(', ') || '(none)',
    })
  }

  // tools_not_called: none of the listed tools was called
  if (assertions.tools_not_called !== undefined) {
    const forbidden = assertions.tools_not_called.filter((t) => artifacts.toolsCalled.includes(t))
    results.push({
      type: 'tools_not_called',
      passed: forbidden.length === 0,
      expected: `not: ${assertions.tools_not_called.join(', ')}`,
      actual: forbidden.length ? `called: ${forbidden.join(', ')}` : artifacts.toolsCalled.join(', ') || '(none)',
    })
  }

  // no_claim_without_call: text matching pattern requires the tool to have been called
  if (assertions.no_claim_without_call !== undefined) {
    const violations: string[] = []
    for (const rule of assertions.no_claim_without_call) {
      let re: RegExp
      try {
        re = new RegExp(rule.pattern, 'i')
      } catch {
        violations.push(`invalid pattern /${rule.pattern}/`)
        continue
      }
      if (re.test(artifacts.assistantResponse) && !artifacts.toolsCalled.includes(rule.requires_tool)) {
        violations.push(`text matches /${rule.pattern}/ but ${rule.requires_tool} was not called`)
      }
    }
    results.push({
      type: 'no_claim_without_call',
      passed: violations.length === 0,
      expected: assertions.no_claim_without_call.map((r) => `/${r.pattern}/ ⇒ ${r.requires_tool}`).join('; '),
      actual: violations.length ? violations.join('; ') : `tools: ${artifacts.toolsCalled.join(', ') || '(none)'}`,
    })
  }

  // assert_tool_param: assert that the expected param key/values were present in any tool call args
  if (assertions.assert_tool_param !== undefined) {
    const expectedParams = assertions.assert_tool_param
    const allArgs = Object.values(artifacts.toolArgs)
    const mergedArgs = Object.assign({}, ...allArgs) as Record<string, unknown>

    const failures: string[] = []
    for (const [key, expectedValue] of Object.entries(expectedParams)) {
      const actualValue = mergedArgs[key]
      if (JSON.stringify(actualValue) !== JSON.stringify(expectedValue)) {
        failures.push(`${key}: expected ${JSON.stringify(expectedValue)}, got ${JSON.stringify(actualValue)}`)
      }
    }

    results.push({
      type: 'assert_tool_param',
      passed: failures.length === 0,
      expected: JSON.stringify(expectedParams),
      actual: failures.length > 0 ? failures.join('; ') : JSON.stringify(mergedArgs),
    })
  }

  // assert_response_contains: case-insensitive substring check on assistant response
  if (assertions.assert_response_contains !== undefined) {
    const expectedText = assertions.assert_response_contains
    const response = artifacts.assistantResponse
    const passed = response.toLowerCase().includes(expectedText.toLowerCase())
    results.push({
      type: 'assert_response_contains',
      passed,
      expected: expectedText,
      actual: response.length > 200 ? response.slice(0, 200) + '…' : response,
    })
  }

  return results
}
