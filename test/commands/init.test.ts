import {existsSync} from 'node:fs'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {loadConfig} from '../../src/lib/config-loader.js'

let tmpDir: string
let originalCwd: string

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'apprhythm-init-'))
  originalCwd = process.cwd()
  process.chdir(tmpDir)
})

afterEach(async () => {
  process.chdir(originalCwd)
  await rm(tmpDir, {force: true, recursive: true})
})

async function runInit(args: string[] = []): Promise<{exitCode: number; stderr: string; stdout: string}> {
  const {execFile} = await import('node:child_process')
  const {promisify} = await import('node:util')
  const exec = promisify(execFile)

  const binPath = path.join(originalCwd, 'bin', 'run.js')
  try {
    const result = await exec('node', [binPath, 'init', ...args], {cwd: tmpDir})
    return {exitCode: 0, stderr: result.stderr, stdout: result.stdout}
  } catch (error: unknown) {
    const e = error as {code?: number; stderr?: string; stdout?: string}
    return {exitCode: e.code ?? 1, stderr: e.stderr ?? '', stdout: e.stdout ?? ''}
  }
}

describe('ritmo init', () => {
  it('creates ritmo.yaml in the current directory', async () => {
    const result = await runInit()
    expect(result.exitCode).toBe(0)
    expect(existsSync(path.join(tmpDir, 'ritmo.yaml'))).toBe(true)
    expect(result.stdout).toContain('Configuration set up and saved to ritmo.yaml')
  })

  it('generates a config that passes schema validation', async () => {
    await runInit()
    const config = await loadConfig(tmpDir)
    expect(config.version).toBe(1)
    expect(config.app.screenshots).toHaveLength(3)
    expect(config.simulate.model).toBe('gpt-4o-mini')
  })

  it('refuses to overwrite an existing config', async () => {
    await writeFile(path.join(tmpDir, 'apprhythm.yaml'), 'existing: true')
    const result = await runInit()
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('already exists')
    expect(result.stderr).toContain('--force')

    // Verify original file was not overwritten
    const content = await readFile(path.join(tmpDir, 'apprhythm.yaml'), 'utf8')
    expect(content).toBe('existing: true')
  })

  it('overwrites with --force and shows overwrite message', async () => {
    await writeFile(path.join(tmpDir, 'apprhythm.yaml'), 'existing: true')
    const result = await runInit(['--force'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Overwrote existing apprhythm.yaml')

    // Verify the file was overwritten with valid config
    const config = await loadConfig(tmpDir)
    expect(config.version).toBe(1)
  })
})

it('accepts a scripted URL without connecting and rejects secrets without echoing them', async () => {
  const result = await runInit(['--server-url', 'https://example.com/mcp', '--skip-check', '--no-interactive'])
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('Connection not checked')
  expect((await loadConfig(tmpDir)).server.url).toBe('https://example.com/mcp')
  const invalid = await runInit(['--force', '--server-url', 'https://user:PRIVATE_VALUE@example.com/mcp', '--skip-check'])
  expect(invalid.exitCode).toBe(1)
  expect(invalid.stderr + invalid.stdout).not.toContain('PRIVATE_VALUE')
  expect((await loadConfig(tmpDir)).server.url).toBe('https://example.com/mcp')
})

it('updates the saved URL through config set while preserving app fields', async () => {
  await runInit()
  const {execFile} = await import('node:child_process')
  const {promisify} = await import('node:util')
  const result = await promisify(execFile)('node', [path.join(originalCwd, 'bin/run.js'), 'config', 'set', 'server.url', 'https://example.com/updated', '--skip-check', '--no-interactive'], {cwd: tmpDir})
  expect(result.stdout).toContain('Updated server.url')
  const config = await loadConfig(tmpDir)
  expect(config.server.url).toBe('https://example.com/updated')
  expect(config.app.name).toBe('My App')
  expect(config.tests[0].file).toBe('./tests/smoke.yaml')
})
