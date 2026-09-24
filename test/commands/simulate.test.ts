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

async function runSimulate(
  args: string[],
  env?: Record<string, string>,
  cwd?: string,
): Promise<{exitCode: number; stderr: string; stdout: string}> {
  try {
    const result = await exec('node', [binPath, 'simulate', ...args], {
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
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'apprhythm-sim-'))
  originalCwd = process.cwd()
  process.chdir(tmpDir)
})

afterEach(async () => {
  process.chdir(originalCwd)
  await rm(tmpDir, {force: true, recursive: true})
})

describe('ritmo simulate — flag validation', () => {
  it('exits non-zero (UI mode) when no apprhythm.yaml exists and no flags given', async () => {
    // UI mode is default; without a config it should fail with a config error
    const result = await runSimulate([])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/apprhythm\.yaml|config/i)
  })

  it('exits non-zero when --message is missing in headless mode', async () => {
    await writeFile(path.join(tmpDir, 'apprhythm.yaml'), VALID_CONFIG)
    const result = await runSimulate(['--headless'])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/message.*required|required.*message/i)
  })

  it('exits non-zero when --message is empty', async () => {
    await writeFile(path.join(tmpDir, 'apprhythm.yaml'), VALID_CONFIG)
    const result = await runSimulate(['--headless', '--message', ''])
    expect(result.exitCode).not.toBe(0)
  })
})

describe('ritmo simulate — --no-ui flag', () => {
  it('--no-ui behaves as an alias for --headless', async () => {
    await writeFile(path.join(tmpDir, 'apprhythm.yaml'), VALID_CONFIG)
    // --no-ui without --message should fail the same way as --headless without --message
    const result = await runSimulate(['--no-ui'])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/message.*required|required.*message/i)
  })

  it('--no-ui with --message reaches MCP connection (same as --headless)', async () => {
    await writeFile(path.join(tmpDir, 'apprhythm.yaml'), VALID_CONFIG)
    const result = await runSimulate(
      ['--no-ui', '--message', 'hello'],
      {RITMO_OPENAI_API_KEY: 'sk-test-fake-key'},
    )
    expect(result.exitCode).not.toBe(0)
    // Reaches MCP connection attempt, just like --headless
    expect(result.stderr).toMatch(/connect|connection|ECONNREFUSED|MCP/i)
  })

  it('logs headless mode when --no-ui is used', async () => {
    await writeFile(path.join(tmpDir, 'apprhythm.yaml'), VALID_CONFIG)
    const result = await runSimulate(['--no-ui', '--message', 'hello'], {RITMO_OPENAI_API_KEY: 'sk-test-fake-key'})
    expect(result.stdout).toMatch(/headless/i)
  })
})

describe('ritmo simulate — mode logging', () => {
  it('logs UI mode when no flags provided', async () => {
    // Will fail on config but should still log mode
    const result = await runSimulate([])
    // The mode log comes before config load, so it should appear in stdout
    expect(result.stdout).toMatch(/UI/i)
  })

  it('logs headless mode when --headless provided', async () => {
    await writeFile(path.join(tmpDir, 'apprhythm.yaml'), VALID_CONFIG)
    const result = await runSimulate(['--headless', '--message', 'hello'], {RITMO_OPENAI_API_KEY: 'sk-test-fake-key'})
    expect(result.stdout).toMatch(/headless/i)
  })
})

describe('ritmo simulate — config validation', () => {
  it('exits non-zero when no apprhythm.yaml exists', async () => {
    const result = await runSimulate(
      ['--headless', '--message', 'hello'],
      {RITMO_OPENAI_API_KEY: 'sk-test'},
    )
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/apprhythm\.yaml|config/i)
  })
})

describe('ritmo simulate — credential validation', () => {
  it('exits non-zero when no OpenAI key is configured', async () => {
    // First ensure no keychain entry exists so credential check fails
    // RITMO_NO_KEYCHAIN isolates the test from the developer's keychain (never delete their key)

    await writeFile(path.join(tmpDir, 'apprhythm.yaml'), VALID_CONFIG)
    // Ensure no env var
    const result = await runSimulate(
      ['--headless', '--message', 'hello'],
      {RITMO_OPENAI_API_KEY: '', RITMO_NO_KEYCHAIN: '1'},
    )
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/credential|api key|openai/i)
  })

  it('uses an explicit Blueprint projection without requiring apprhythm.yaml', async () => {
    const result = await runSimulate(
      ['--headless', '--message', 'hello', '--blueprint', blueprintFixture],
      {RITMO_OPENAI_API_KEY: '', RITMO_NO_KEYCHAIN: '1'},
    )
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/credential|api key|openai/i)
    expect(result.stderr).not.toMatch(/could not load apprhythm\.yaml/i)
  })
})

describe('ritmo simulate — MCP connection failure', () => {
  it('exits non-zero when MCP server is unreachable', async () => {
    await writeFile(path.join(tmpDir, 'apprhythm.yaml'), VALID_CONFIG)
    const result = await runSimulate(
      ['--headless', '--message', 'hello'],
      {RITMO_OPENAI_API_KEY: 'sk-test-fake-key'},
    )
    expect(result.exitCode).not.toBe(0)
    // Should fail on MCP connection before hitting OpenAI
    expect(result.stderr).toMatch(/connect|connection|ECONNREFUSED|MCP/i)
  })
})
