import {execFile} from 'node:child_process'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {promisify} from 'node:util'

import {afterEach, beforeEach, describe, expect, it} from 'vitest'

const exec = promisify(execFile)
const binPath = path.resolve(__dirname, '../../bin/run.js')
const blueprintFixture = path.resolve(__dirname, '../fixtures/blueprint/representative-v1.json')

let tmpDir: string
let originalCwd: string

async function runTest(
  args: string[],
  env?: Record<string, string>,
  cwd?: string,
): Promise<{exitCode: number; stderr: string; stdout: string}> {
  try {
    const result = await exec('node', [binPath, 'test', ...args], {
      cwd: cwd ?? tmpDir,
      env: {...process.env, ...env},
    })
    return {exitCode: 0, stderr: result.stderr, stdout: result.stdout}
  } catch (error: unknown) {
    const e = error as {code?: number; stderr?: string; stdout?: string}
    return {exitCode: e.code ?? 1, stderr: e.stderr ?? '', stdout: e.stdout ?? ''}
  }
}

const VALID_CONFIG = `
version: 1
app:
  name: "Test App"
  description: "desc"
  icon: "./icon.png"
  screenshots:
    - "./s1.png"
    - "./s2.png"
    - "./s3.png"
server:
  url: "http://localhost:19999/mcp"
simulate:
  model: "gpt-4o-mini"
  default_context:
    locale: "en-US"
    timezone: "America/New_York"
tests:
  - file: "./tests/smoke.yaml"
`

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'apprhythm-test-cmd-'))
  originalCwd = process.cwd()
  process.chdir(tmpDir)
})

afterEach(async () => {
  process.chdir(originalCwd)
  await rm(tmpDir, {force: true, recursive: true})
})

describe('ritmo test — flag validation', () => {
  it('exits non-zero with unsupported reporter', async () => {
    await writeFile(path.join(tmpDir, 'apprhythm.yaml'), VALID_CONFIG)
    const result = await runTest(['--reporter', 'xml'])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/unsupported reporter/i)
  })

  it('exits non-zero when --file points to nonexistent file', async () => {
    await writeFile(path.join(tmpDir, 'apprhythm.yaml'), VALID_CONFIG)
    const result = await runTest(
      ['--file', './nonexistent.yaml'],
      {RITMO_OPENAI_API_KEY: 'sk-test'},
    )
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/not found|does not exist/i)
  })
})

describe('ritmo test — config validation', () => {
  it('exits non-zero when no apprhythm.yaml exists', async () => {
    const result = await runTest([])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/apprhythm\.yaml|config/i)
  })

  it('uses an explicit Blueprint projection without requiring apprhythm.yaml', async () => {
    const result = await runTest(['--blueprint', blueprintFixture], {RITMO_OPENAI_API_KEY: '', RITMO_NO_KEYCHAIN: '1'})

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/credential|api key|openai/i)
    expect(result.stderr).not.toMatch(/could not load apprhythm\.yaml/i)
  })

  it('rejects conflicting Blueprint and suite inputs before credential resolution', async () => {
    const result = await runTest(['--blueprint', blueprintFixture, '--file', './tests/smoke.yaml'])

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('[blueprint]')
    expect(result.stderr).toContain('incompatible')
  })
})

describe('ritmo test — credential validation', () => {
  it('exits non-zero when no OpenAI key is configured', async () => {
    // Clean up keychain to ensure no key exists
    // RITMO_NO_KEYCHAIN isolates the test from the developer's keychain (never delete their key)

    await writeFile(path.join(tmpDir, 'apprhythm.yaml'), VALID_CONFIG)
    // Create the referenced smoke test file so YAML load passes
    const testsDir = path.join(tmpDir, 'tests')
    await import('node:fs/promises').then((fs) => fs.mkdir(testsDir, {recursive: true}))
    await writeFile(path.join(testsDir, 'smoke.yaml'), 'tests:\n  - user: "hello"\n')
    const result = await runTest([], {RITMO_OPENAI_API_KEY: '', RITMO_NO_KEYCHAIN: '1'})
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/credential|api key|openai/i)
  })
})

describe('ritmo test — MCP connection failure', () => {
  it('exits non-zero when MCP server is unreachable', async () => {
    await writeFile(path.join(tmpDir, 'apprhythm.yaml'), VALID_CONFIG)
    // Create the referenced smoke test file so YAML load passes before MCP connect
    const testsDir = path.join(tmpDir, 'tests')
    await import('node:fs/promises').then((fs) => fs.mkdir(testsDir, {recursive: true}))
    await writeFile(path.join(testsDir, 'smoke.yaml'), 'tests:\n  - user: "hello"\n')
    const result = await runTest([], {RITMO_OPENAI_API_KEY: 'sk-test-fake'})
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/connect|connection|ECONNREFUSED|MCP/i)
  })
})

describe('ritmo test — YAML validation', () => {
  it('exits non-zero for a test file with invalid schema', async () => {
    const badFile = path.join(tmpDir, 'bad.yaml')
    await writeFile(badFile, 'tests: []\n')
    await writeFile(path.join(tmpDir, 'apprhythm.yaml'), VALID_CONFIG)
    const result = await runTest(
      ['--file', badFile],
      {RITMO_OPENAI_API_KEY: 'sk-test'},
    )
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/at least 1|schema|invalid/i)
  })

  it('exits non-zero for malformed YAML syntax', async () => {
    const badFile = path.join(tmpDir, 'malformed.yaml')
    await writeFile(badFile, 'tests:\n  - [bad\n')
    await writeFile(path.join(tmpDir, 'apprhythm.yaml'), VALID_CONFIG)
    const result = await runTest(
      ['--file', badFile],
      {RITMO_OPENAI_API_KEY: 'sk-test'},
    )
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/parse|yaml|invalid/i)
  })
})

describe('ritmo test — reporter flag', () => {
  async function setupWithSmokeFile() {
    await writeFile(path.join(tmpDir, 'apprhythm.yaml'), VALID_CONFIG)
    const testsDir = path.join(tmpDir, 'tests')
    await import('node:fs/promises').then((fs) => fs.mkdir(testsDir, {recursive: true}))
    await writeFile(path.join(testsDir, 'smoke.yaml'), 'tests:\n  - user: "hello"\n')
  }

  it('accepts --reporter cli as valid option', async () => {
    // Just check it gets past reporter validation — MCP will fail after
    await setupWithSmokeFile()
    const result = await runTest(
      ['--reporter', 'cli'],
      {RITMO_OPENAI_API_KEY: 'sk-test'},
    )
    // Should fail on MCP, not reporter validation
    expect(result.stderr).not.toMatch(/unsupported reporter/i)
  })

  it('accepts --reporter junit as valid option', async () => {
    await setupWithSmokeFile()
    const result = await runTest(
      ['--reporter', 'junit'],
      {RITMO_OPENAI_API_KEY: 'sk-test'},
    )
    expect(result.stderr).not.toMatch(/unsupported reporter/i)
  })
})
