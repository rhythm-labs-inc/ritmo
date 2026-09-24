import {z} from 'zod'

/**
 * A single assertion within a test case.
 * All assertion fields are optional; at least one should be provided.
 */
const assertionSchema = z.object({
  /** Assert that a specific tool was called (by name) during this turn */
  expect_tool: z.string().min(1).optional(),
  /** Assert that the tool call included these exact parameter key/values */
  assert_tool_param: z.record(z.unknown()).optional(),
  /** Assert that the final assistant response contains this text (case-insensitive substring) */
  assert_response_contains: z.string().min(1).optional(),
  /** Assert that NO tool was called during this turn (negative / must-not-trigger cases) */
  expect_no_tool_call: z.literal(true).optional(),
  /** Assert that no tool result in this turn produced a contract/* finding at or above this severity */
  assert_contract: z.enum(['clean', 'no-fail']).optional(),
  /** All of these tools must be called this turn; `[]` = no tool may be called (negative case) */
  tools_called: z.array(z.string().min(1)).optional(),
  /** None of these tools may be called this turn */
  tools_not_called: z.array(z.string().min(1)).optional(),
  /**
   * Honesty check: if the assistant text matches `pattern` (regex, case-insensitive) then
   * `requires_tool` must have been called this turn — catches "I've reopened the tuner" with no call (RHY-176).
   */
  no_claim_without_call: z.array(z.object({
    pattern: z.string().min(1),
    requires_tool: z.string().min(1),
  }).strict()).optional(),
})

/**
 * Simulated host identity for a case or turn (docs/apps-sdk-contract.md §5).
 *   subject: pin the openai/subject for this case/turn ('new' = fresh random subject)
 *   session: 'same' (default within a case) or 'new' — rotate openai/session for this turn
 *   none:    true → send no identity _meta
 */
const identitySchema = z.object({
  subject: z.string().min(1).optional(),
  session: z.enum(['same', 'new']).optional(),
  none: z.literal(true).optional(),
}).strict()

/**
 * One turn of a multi-turn case: a user message plus assertions evaluated
 * against THAT turn's tool calls / assistant reply.
 */
const turnSchema = z.object({
  user: z.string().min(1, 'turn user message must not be empty'),
  identity: identitySchema.optional(),
}).merge(assertionSchema)

/**
 * A single test case. Two forms:
 *   - single-turn: `user` + assertions
 *   - multi-turn:  `turns: [{user, …assertions}, …]` — one conversation, assertions per turn.
 *     Top-level assertions (if any) apply to the LAST turn.
 */
const testCaseSchema = z.object({
  /** Human-readable name for this test case (optional but recommended) */
  name: z.string().optional(),
  /** Golden-prompt class for the discovery report: direct (@mention), indirect (intent only), negative (must not trigger) */
  class: z.enum(['direct', 'indirect', 'negative']).optional(),
  /** The user message to send to the simulation loop (single-turn form) */
  user: z.string().min(1, 'test case user message must not be empty').optional(),
  /** Multi-turn form */
  turns: z.array(turnSchema).min(1, 'turns must contain at least 1 turn').optional(),
  /** Identity for the whole case (turn-level `identity` overrides per turn) */
  identity: identitySchema.optional(),
}).merge(assertionSchema).refine(
  (tc) => (tc.user !== undefined) !== (tc.turns !== undefined),
  {message: 'a test case needs exactly one of "user" or "turns"'},
)

/**
 * A complete test suite file.
 */
export const testSuiteSchema = z.object({
  /** Optional suite-level name shown in reports */
  suite: z.string().optional(),
  /** Ordered list of test cases */
  tests: z.array(testCaseSchema).min(1, 'test suite must contain at least 1 test case'),
})

export type Assertion = z.infer<typeof assertionSchema>
export type TestIdentity = z.infer<typeof identitySchema>
export type TestTurn = z.infer<typeof turnSchema>
export type TestCase = z.infer<typeof testCaseSchema>

/** Extract only the assertion fields from a case or turn. */
export function pickAssertions(src: Assertion): Assertion {
  return {
    expect_tool: src.expect_tool,
    assert_tool_param: src.assert_tool_param,
    assert_response_contains: src.assert_response_contains,
    expect_no_tool_call: src.expect_no_tool_call,
    assert_contract: src.assert_contract,
    tools_called: src.tools_called,
    tools_not_called: src.tools_not_called,
    no_claim_without_call: src.no_claim_without_call,
  }
}

/** Does this assertion object assert anything? */
export function hasAnyAssertion(a: Assertion): boolean {
  return a.expect_tool !== undefined || a.assert_tool_param !== undefined || a.assert_response_contains !== undefined || a.expect_no_tool_call !== undefined || a.assert_contract !== undefined
    || a.tools_called !== undefined || a.tools_not_called !== undefined || a.no_claim_without_call !== undefined
}

/** Normalise a case into an ordered list of turns with their assertions. */
export function turnsOf(tc: TestCase): TestTurn[] {
  if (tc.turns) {
    const turns = tc.turns.map((t) => ({...t, identity: t.identity ?? tc.identity}))
    // Top-level assertions apply to the last turn
    const top = pickAssertions(tc)
    if (hasAnyAssertion(top)) {
      const last = turns[turns.length - 1]
      turns[turns.length - 1] = {...last, ...Object.fromEntries(Object.entries(top).filter(([, v]) => v !== undefined))}
    }
    return turns
  }
  return [{user: tc.user!, identity: tc.identity, ...pickAssertions(tc)}]
}
export type TestSuite = z.infer<typeof testSuiteSchema>

/** Tools a case/turn expects to be called (union of expect_tool + tools_called), for the discovery report. */
export function expectedTools(a: Assertion): string[] {
  const out = new Set<string>()
  if (a.expect_tool) out.add(a.expect_tool)
  for (const t of a.tools_called ?? []) out.add(t)
  return [...out]
}
