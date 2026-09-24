import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {describe, expect, it, afterEach, beforeEach} from 'vitest'

import {loadTestSuite, TestLoadError} from '../../src/lib/test-runner/loader.js'

const FIXTURES = path.resolve(__dirname, '../fixtures/tests')

let tmpDir: string
beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'apprhythm-loader-'))
})
afterEach(async () => {
  await rm(tmpDir, {force: true, recursive: true})
})

describe('loadTestSuite — valid files', () => {
  it('loads a valid suite with suite name and tests', async () => {
    const suite = await loadTestSuite(path.join(FIXTURES, 'valid-passing.yaml'))
    expect(suite.suite).toBe('Passing smoke tests')
    expect(suite.tests).toHaveLength(2)
    expect(suite.tests[0].user).toBe('Say hello')
    expect(suite.tests[0].assert_response_contains).toBe('hello')
    expect(suite.tests[1].user).toBe('What is 2+2?')
  })

  it('loads a suite without optional suite name', async () => {
    const filePath = path.join(tmpDir, 'no-name.yaml')
    await writeFile(filePath, 'tests:\n  - user: "hello"\n')
    const suite = await loadTestSuite(filePath)
    expect(suite.suite).toBeUndefined()
    expect(suite.tests).toHaveLength(1)
  })

  it('loads a suite with all assertion types', async () => {
    const filePath = path.join(tmpDir, 'all-assertions.yaml')
    await writeFile(filePath, [
      'suite: "Full"',
      'tests:',
      '  - name: "Full assertions"',
      '    user: "Do stuff"',
      '    expect_tool: my_tool',
      '    assert_tool_param:',
      '      key: value',
      '    assert_response_contains: success',
    ].join('\n'))
    const suite = await loadTestSuite(filePath)
    const tc = suite.tests[0]
    expect(tc.expect_tool).toBe('my_tool')
    expect(tc.assert_tool_param).toEqual({key: 'value'})
    expect(tc.assert_response_contains).toBe('success')
  })
})

describe('loadTestSuite — error cases', () => {
  it('throws TestLoadError for nonexistent file', async () => {
    await expect(loadTestSuite('/nonexistent/path/test.yaml'))
      .rejects.toSatisfy((e: unknown) => e instanceof TestLoadError && e.message.includes('not found'))
  })

  it('throws TestLoadError for invalid YAML syntax', async () => {
    await expect(loadTestSuite(path.join(FIXTURES, 'invalid-yaml.yaml')))
      .rejects.toSatisfy((e: unknown) => e instanceof TestLoadError && e.message.includes('parse'))
  })

  it('throws TestLoadError for schema violation (empty tests array)', async () => {
    await expect(loadTestSuite(path.join(FIXTURES, 'invalid-schema.yaml')))
      .rejects.toSatisfy((e: unknown) => e instanceof TestLoadError && e.message.includes('at least 1'))
  })

  it('throws TestLoadError for empty file', async () => {
    const filePath = path.join(tmpDir, 'empty.yaml')
    await writeFile(filePath, '')
    await expect(loadTestSuite(filePath))
      .rejects.toSatisfy((e: unknown) => e instanceof TestLoadError)
  })

  it('throws TestLoadError for test case with empty user message', async () => {
    const filePath = path.join(tmpDir, 'bad-user.yaml')
    await writeFile(filePath, 'tests:\n  - user: ""\n')
    await expect(loadTestSuite(filePath))
      .rejects.toSatisfy((e: unknown) => e instanceof TestLoadError && e.message.includes('user message'))
  })
})
