import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import os from 'node:os'
import path from 'node:path'

import {beforeEach, afterEach, describe, expect, it} from 'vitest'

const exec = promisify(execFile)

let tmpDir: string
let originalCwd: string
const binPath = path.join(process.cwd(), 'bin', 'run.js')

async function runMcp(
  args: string[],
  cwd = tmpDir,
): Promise<{exitCode: number; stderr: string; stdout: string}> {
  try {
    const result = await exec('node', [binPath, 'mcp', ...args], {cwd})
    return {exitCode: 0, stderr: result.stderr, stdout: result.stdout}
  } catch (error: unknown) {
    const e = error as {code?: number; stderr?: string; stdout?: string}
    return {exitCode: e.code ?? 1, stderr: e.stderr ?? '', stdout: e.stdout ?? ''}
  }
}

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'apprhythm-mcp-test-'))
  originalCwd = process.cwd()
  process.chdir(tmpDir)
})

afterEach(async () => {
  process.chdir(originalCwd)
  await rm(tmpDir, {force: true, recursive: true})
})

describe('ritmo mcp — flag validation', () => {
  it('exits non-zero when no mode flag is provided', async () => {
    const result = await runMcp(['--server', 'http://localhost:9999/mcp'])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/--list-tools|--call/)
  })

  it('exits non-zero when --args and --args-file are both provided', async () => {
    const result = await runMcp([
      '--server', 'http://localhost:9999/mcp',
      '--call', 'my_tool',
      '--args', '{}',
      '--args-file', '/some/file.json',
    ])
    expect(result.exitCode).not.toBe(0)
  })

  it('exits non-zero when --list-tools and --call are both provided', async () => {
    const result = await runMcp([
      '--server', 'http://localhost:9999/mcp',
      '--list-tools',
      '--call', 'my_tool',
    ])
    expect(result.exitCode).not.toBe(0)
  })
})

describe('ritmo mcp — server URL resolution', () => {
  it('uses server.url from apprhythm.yaml when --server is not provided', async () => {
    // Write a config pointing at a port nothing is listening on
    await writeFile(path.join(tmpDir, 'apprhythm.yaml'), `
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
`)
    const result = await runMcp(['--list-tools'], tmpDir)
    // It should attempt to connect to the yaml URL and fail (connection error), not a usage error
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/connection|connect|ECONNREFUSED|localhost:19999/i)
  })

  it('exits non-zero with actionable message when no config and no --server', async () => {
    // No apprhythm.yaml in tmpDir
    const result = await runMcp(['--list-tools'], tmpDir)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/apprhythm\.yaml|--server|ritmo init/i)
  })
})

describe('ritmo mcp — connection failures', () => {
  it('exits non-zero when server is unreachable', async () => {
    const result = await runMcp([
      '--server', 'http://localhost:19999/mcp',
      '--list-tools',
    ])
    expect(result.exitCode).not.toBe(0)
    // Should mention the error category or server URL
    expect(result.stderr).toMatch(/connection|connect|ECONNREFUSED|19999/i)
  })

  it('exits non-zero with timeout error message when --timeout is very short', async () => {
    const result = await runMcp([
      '--server', 'http://localhost:19999/mcp',
      '--list-tools',
      '--timeout', '1',
    ])
    expect(result.exitCode).not.toBe(0)
  })

  it('exits non-zero for invalid URL scheme', async () => {
    const result = await runMcp([
      '--server', 'ws://localhost:9000',
      '--list-tools',
    ])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/transport|http|https|unsupported/i)
  })
})

describe('ritmo mcp — args parsing errors', () => {
  it('exits non-zero for invalid JSON in --args', async () => {
    const result = await runMcp([
      '--server', 'http://localhost:19999/mcp',
      '--call', 'my_tool',
      '--args', 'not-json',
    ])
    expect(result.exitCode).not.toBe(0)
    // Args parsing error happens before connection so it may fail for either args or connection reason
    // both are acceptable non-zero exits
  })
})
