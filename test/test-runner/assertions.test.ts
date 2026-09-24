import {describe, expect, it} from 'vitest'

import {evaluateAssertions, type ExecutionArtifacts} from '../../src/lib/test-runner/assertions.js'
import type {Assertion} from '../../src/lib/test-runner/schema.js'

function makeArtifacts(overrides: Partial<ExecutionArtifacts> = {}): ExecutionArtifacts {
  return {
    toolsCalled: [],
    toolArgs: {},
    assistantResponse: 'The answer is 42',
    trace: [],
    ...overrides,
  }
}

describe('evaluateAssertions — expect_tool', () => {
  it('passes when the expected tool was called', () => {
    const assertion: Assertion = {expect_tool: 'search_docs'}
    const artifacts = makeArtifacts({toolsCalled: ['search_docs', 'format_result']})
    const results = evaluateAssertions(assertion, artifacts)
    expect(results).toHaveLength(1)
    expect(results[0].passed).toBe(true)
    expect(results[0].type).toBe('expect_tool')
  })

  it('fails when the expected tool was not called', () => {
    const assertion: Assertion = {expect_tool: 'missing_tool'}
    const artifacts = makeArtifacts({toolsCalled: ['other_tool']})
    const results = evaluateAssertions(assertion, artifacts)
    expect(results[0].passed).toBe(false)
    expect(results[0].expected).toBe('missing_tool')
  })

  it('fails when no tools were called', () => {
    const assertion: Assertion = {expect_tool: 'any_tool'}
    const results = evaluateAssertions(assertion, makeArtifacts())
    expect(results[0].passed).toBe(false)
    expect(results[0].actual).toBe('(none)')
  })
})

describe('evaluateAssertions — assert_tool_param', () => {
  it('passes when all expected params match', () => {
    const assertion: Assertion = {assert_tool_param: {location: 'Paris', unit: 'celsius'}}
    const artifacts = makeArtifacts({
      toolArgs: {get_weather: {location: 'Paris', unit: 'celsius', extra: 'ignored'}},
    })
    const results = evaluateAssertions(assertion, artifacts)
    expect(results[0].passed).toBe(true)
  })

  it('fails when a param value does not match', () => {
    const assertion: Assertion = {assert_tool_param: {status: 'Done'}}
    const artifacts = makeArtifacts({
      toolArgs: {update_issue: {status: 'In Progress'}},
    })
    const results = evaluateAssertions(assertion, artifacts)
    expect(results[0].passed).toBe(false)
    expect(results[0].actual).toContain('status')
  })

  it('fails when no tools were called and params are expected', () => {
    const assertion: Assertion = {assert_tool_param: {key: 'value'}}
    const results = evaluateAssertions(assertion, makeArtifacts())
    expect(results[0].passed).toBe(false)
  })

  it('merges params across multiple tool calls', () => {
    const assertion: Assertion = {assert_tool_param: {a: 1, b: 2}}
    const artifacts = makeArtifacts({
      toolArgs: {tool1: {a: 1}, tool2: {b: 2}},
    })
    const results = evaluateAssertions(assertion, artifacts)
    expect(results[0].passed).toBe(true)
  })
})

describe('evaluateAssertions — assert_response_contains', () => {
  it('passes for case-insensitive substring match', () => {
    const assertion: Assertion = {assert_response_contains: 'answer'}
    const artifacts = makeArtifacts({assistantResponse: 'The ANSWER is 42'})
    const results = evaluateAssertions(assertion, artifacts)
    expect(results[0].passed).toBe(true)
  })

  it('fails when the expected text is not in the response', () => {
    const assertion: Assertion = {assert_response_contains: 'xyzzy_missing'}
    const results = evaluateAssertions(assertion, makeArtifacts())
    expect(results[0].passed).toBe(false)
    expect(results[0].expected).toBe('xyzzy_missing')
  })

  it('truncates very long actual responses in output', () => {
    const assertion: Assertion = {assert_response_contains: 'nope'}
    const longResponse = 'a'.repeat(300)
    const artifacts = makeArtifacts({assistantResponse: longResponse})
    const results = evaluateAssertions(assertion, artifacts)
    expect(results[0].actual.length).toBeLessThanOrEqual(204) // 200 chars + '…'
  })
})

describe('evaluateAssertions — multiple assertions', () => {
  it('returns results for each assertion present', () => {
    const assertion: Assertion = {
      expect_tool: 'my_tool',
      assert_response_contains: 'success',
    }
    const artifacts = makeArtifacts({
      toolsCalled: ['my_tool'],
      assistantResponse: 'Operation success!',
    })
    const results = evaluateAssertions(assertion, artifacts)
    expect(results).toHaveLength(2)
    expect(results.every((r) => r.passed)).toBe(true)
  })

  it('returns empty array when no assertions are defined', () => {
    const assertion: Assertion = {}
    const results = evaluateAssertions(assertion, makeArtifacts())
    expect(results).toHaveLength(0)
  })
})
