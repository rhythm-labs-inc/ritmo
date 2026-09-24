import type {UsageSummary} from '../simulate/usage.js'
import type {AnswerFinding} from '../simulate/source-fidelity.js'
/**
 * Shared in-memory result model for all reporters.
 */

export interface AssertionResult {
  type: 'expect_tool' | 'assert_tool_param' | 'assert_response_contains' | 'expect_no_tool_call' | 'assert_contract' | 'tools_called' | 'tools_not_called' | 'no_claim_without_call'
  passed: boolean
  expected: string
  actual: string
  /** 1-based turn index for multi-turn cases; absent for single-turn. */
  turn?: number
}

export type TestOutcome = 'pass' | 'fail' | 'error'

export interface TestCaseResult {
  usage?: UsageSummary
  answerFindings?: AnswerFinding[]
  /** Index of this test within its suite (0-based) */
  index: number
  /** Test case name (from YAML) or auto-generated */
  name: string
  /** User message that was sent (for multi-turn cases: the turns joined with " ⟶ ") */
  userMessage: string
  /** Number of turns run (1 for single-turn) */
  turnCount?: number
  /** Golden-prompt class from the YAML */
  class?: 'direct' | 'indirect' | 'negative'
  /** Tools the case expected (union of expect_tool + tools_called across turns) */
  expectedTools?: string[]
  /** With --runs N: per-run outcomes; `outcome` is 'pass' only if every run passed */
  runs?: Array<{outcome: TestOutcome; toolsCalled: string[]}>
  /** With --runs N: fraction of runs whose assertions all passed */
  passRate?: number
  outcome: TestOutcome
  /** Per-assertion outcomes (only present on pass/fail, not error) */
  assertions: AssertionResult[]
  /** Runtime error message if outcome is 'error' */
  errorMessage?: string
  /** Tool names that were called during this test */
  toolsCalled: string[]
  /** The final assistant response text */
  assistantResponse: string
}

export interface SuiteResult {
  usage?: UsageSummary
  suiteName: string
  filePath: string
  cases: TestCaseResult[]
  /** Execution duration in ms for the whole suite */
  durationMs: number
}

export function countPassed(suite: SuiteResult): number {
  return suite.cases.filter((c) => c.outcome === 'pass').length
}

export function countFailed(suite: SuiteResult): number {
  return suite.cases.filter((c) => c.outcome === 'fail').length
}

export function countErrored(suite: SuiteResult): number {
  return suite.cases.filter((c) => c.outcome === 'error').length
}

export function suiteAllPassed(suite: SuiteResult): boolean {
  return suite.cases.every((c) => c.outcome === 'pass')
}
