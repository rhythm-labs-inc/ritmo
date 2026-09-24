import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import path from 'node:path'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {type KeytarBackend, setBackend} from '../../src/lib/credentials/store.js'
import {resolveCredential} from '../../src/lib/credentials/resolution.js'

const exec = promisify(execFile)
const binPath = path.resolve(__dirname, '../../bin/run.js')
const isolatedEnv = {RITMO_NO_KEYCHAIN: '1'}

async function runAuth(
  args: string[],
  env?: Record<string, string>,
): Promise<{exitCode: number; stderr: string; stdout: string}> {
  try {
    const result = await exec('node', [binPath, 'auth', ...args], {
      env: {...process.env, ...isolatedEnv, ...env},
    })
    return {exitCode: 0, stderr: result.stderr, stdout: result.stdout}
  } catch (error: unknown) {
    const e = error as {code?: number; stderr?: string; stdout?: string}
    return {exitCode: e.code ?? 1, stderr: e.stderr ?? '', stdout: e.stdout ?? ''}
  }
}

describe('ritmo auth — CLI command tests', () => {
  describe('auth (no subcommand)', () => {
    it('shows help text with available subcommands', async () => {
      const result = await runAuth([])
      // oclif may send topic help to stdout or stderr depending on version
      const combined = result.stdout + result.stderr
      expect(combined).toMatch(/set-key|status|remove-key/)
    })
  })

  describe('auth set-key', () => {
    it('exits non-zero when --provider is missing', async () => {
      const result = await runAuth(['set-key'])
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatch(/provider|required/i)
    })

    it('exits non-zero for unsupported provider', async () => {
      // set-key with unsupported provider will fail before prompting for input
      const result = await runAuth(['set-key', '--provider', 'azure'])
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatch(/unsupported|Unsupported/i)
    })

  })

  describe('auth status', () => {
    it('shows "not configured" when no credential is set', async () => {
      // The CLI suite deliberately avoids depending on a developer keychain.
      const result = await runAuth(['status'], {RITMO_OPENAI_API_KEY: ''})
      expect(result.stdout).toContain('openai')
      expect(result.stdout).toMatch(/not configured/)
    })

    it('shows env source when env var is set', async () => {
      const result = await runAuth(['status'], {RITMO_OPENAI_API_KEY: 'sk-env-test-value'})
      expect(result.stdout).toContain('openai')
      expect(result.stdout).toContain('env')
      expect(result.stdout).toContain('configured')
    })

    it('never shows full key value in output', async () => {
      const key = 'sk-supersecretkey12345678'
      const result = await runAuth(['status'], {RITMO_OPENAI_API_KEY: key})
      expect(result.stdout).not.toContain(key)
      // Should show masked version (last 4 chars)
      expect(result.stdout).toContain('5678')
      expect(result.stdout).toContain('****')
    })
  })

  describe('auth remove-key', () => {
    it('exits non-zero when --provider is missing', async () => {
      const result = await runAuth(['remove-key'])
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatch(/provider|required/i)
    })

    it('exits non-zero for unsupported provider', async () => {
      const result = await runAuth(['remove-key', '--provider', 'azure'])
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatch(/unsupported|Unsupported/i)
    })

  })
})

// Unit-level tests using mock backend directly (no CLI binary)
describe('credential resolution — unit tests', () => {
  let store: Map<string, string>
  let backend: KeytarBackend
  const originalNoKeychain = process.env.RITMO_NO_KEYCHAIN

  beforeEach(() => {
    store = new Map()
    backend = {
      setPassword: vi.fn(async (_s: string, account: string, password: string) => {
        store.set(account, password)
      }),
      getPassword: vi.fn(async (_s: string, account: string) => store.get(account) ?? null),
      deletePassword: vi.fn(async (_s: string, account: string) => store.delete(account)),
    }
    setBackend(backend)
    delete process.env.RITMO_OPENAI_API_KEY
    vi.stubEnv('RITMO_NO_KEYCHAIN', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    setBackend(null)
    delete process.env.RITMO_OPENAI_API_KEY
    if (originalNoKeychain === undefined) delete process.env.RITMO_NO_KEYCHAIN
    else process.env.RITMO_NO_KEYCHAIN = originalNoKeychain
  })

  it('resolves from keychain after set', async () => {
    store.set('openai', 'sk-from-keychain')
    const result = await resolveCredential('openai')
    expect(result?.source).toBe('keychain')
  })

  it('resolves from env when both are available', async () => {
    store.set('openai', 'sk-keychain')
    process.env.RITMO_OPENAI_API_KEY = 'sk-env'
    const result = await resolveCredential('openai')
    expect(result?.source).toBe('env')
  })

  it('returns null when nothing is configured', async () => {
    const result = await resolveCredential('openai')
    expect(result).toBeNull()
  })
})

// No-secret-leak tests
describe('no-secret-leak guarantees', () => {
  it('auth status output never contains a full key value via env', async () => {
    const fullKey = 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    const result = await runAuth(['status'], {RITMO_OPENAI_API_KEY: fullKey})
    const combined = result.stdout + result.stderr
    expect(combined).not.toContain(fullKey)
  })

  it('auth set-key error output never contains the provider key value', async () => {
    // Trigger an error with an unsupported provider — error should not leak any key
    const result = await runAuth(['set-key', '--provider', 'badprovider'])
    const combined = result.stdout + result.stderr
    expect(combined).not.toMatch(/sk-/)
  })

  it('auth remove-key error output never contains key values', async () => {
    const result = await runAuth(['remove-key', '--provider', 'badprovider'])
    const combined = result.stdout + result.stderr
    expect(combined).not.toMatch(/sk-/)
  })
})
