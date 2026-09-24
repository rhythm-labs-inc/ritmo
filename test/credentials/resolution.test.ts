import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {type KeytarBackend, setBackend} from '../../src/lib/credentials/store.js'
import {resolveCredential} from '../../src/lib/credentials/resolution.js'

let store: Map<string, string>
let backend: KeytarBackend
const originalNoKeychain = process.env.APPRHYTHM_NO_KEYCHAIN

beforeEach(() => {
  vi.stubEnv('RITMO_NO_KEYCHAIN', '')
  vi.stubEnv('RITMO_OPENAI_API_KEY', undefined)
  store = new Map()
  backend = {
    setPassword: vi.fn(async (_service: string, account: string, password: string) => {
      store.set(account, password)
    }),
    getPassword: vi.fn(async (_service: string, account: string) => {
      return store.get(account) ?? null
    }),
    deletePassword: vi.fn(async (_service: string, account: string) => {
      return store.delete(account)
    }),
  }
  setBackend(backend)
  delete process.env.APPRHYTHM_OPENAI_API_KEY
  // These unit tests inject their backend, so they must exercise the
  // keychain branch even when CI disables real OS-keychain access.
  delete process.env.APPRHYTHM_NO_KEYCHAIN
})

afterEach(() => {
  vi.unstubAllEnvs()
  setBackend(null)
  delete process.env.APPRHYTHM_OPENAI_API_KEY
  if (originalNoKeychain === undefined) delete process.env.APPRHYTHM_NO_KEYCHAIN
  else process.env.APPRHYTHM_NO_KEYCHAIN = originalNoKeychain
})

describe('resolveCredential', () => {
  it('returns null when neither env nor keychain has a value', async () => {
    const result = await resolveCredential('openai')
    expect(result).toBeNull()
  })

  it('returns keychain source when only keychain has a value', async () => {
    store.set('openai', 'sk-keychain-only')
    const result = await resolveCredential('openai')
    expect(result).toEqual({value: 'sk-keychain-only', source: 'keychain'})
  })

  it('returns env source when only env var has a value', async () => {
    process.env.APPRHYTHM_OPENAI_API_KEY = 'sk-env-only'
    const result = await resolveCredential('openai')
    expect(result).toEqual({value: 'sk-env-only', source: 'env'})
  })

  it('env var takes precedence over keychain when both are set', async () => {
    process.env.APPRHYTHM_OPENAI_API_KEY = 'sk-from-env'
    store.set('openai', 'sk-from-keychain')
    const result = await resolveCredential('openai')
    expect(result).toEqual({value: 'sk-from-env', source: 'env'})
  })

  it('falls back to keychain when env var is empty', async () => {
    process.env.APPRHYTHM_OPENAI_API_KEY = ''
    store.set('openai', 'sk-fallback')
    const result = await resolveCredential('openai')
    expect(result).toEqual({value: 'sk-fallback', source: 'keychain'})
  })
})
