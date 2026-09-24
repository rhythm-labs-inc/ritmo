import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {CredentialError} from '../../src/lib/credentials/errors.js'
import {
  type KeytarBackend,
  deleteCredential,
  getCredential,
  setBackend,
  setCredential,
} from '../../src/lib/credentials/store.js'

function makeMockBackend(): KeytarBackend {
  const store = new Map<string, string>()
  return {
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
}

let backend: KeytarBackend

beforeEach(() => {
  backend = makeMockBackend()
  setBackend(backend)
})

afterEach(() => {
  setBackend(null)
})

describe('credential store', () => {
  describe('setCredential', () => {
    it('stores a key via the backend', async () => {
      await setCredential('openai', 'sk-abc123')
      expect(backend.setPassword).toHaveBeenCalledWith('ritmo', 'openai', 'sk-abc123')
    })

    it('throws CredentialError on backend failure', async () => {
      const failingBackend: KeytarBackend = {
        setPassword: vi.fn(async () => { throw new Error('OS denied') }),
        getPassword: vi.fn(async () => null),
        deletePassword: vi.fn(async () => false),
      }
      setBackend(failingBackend)

      await expect(setCredential('openai', 'sk-abc')).rejects.toSatisfy((err: unknown) => {
        return err instanceof CredentialError && err.category === 'keychain-failure'
      })
    })
  })

  describe('getCredential', () => {
    it('retrieves a previously stored key', async () => {
      await setCredential('openai', 'sk-test')
      const result = await getCredential('openai')
      expect(result).toBe('sk-test')
    })

    it('returns null when no key is stored', async () => {
      const result = await getCredential('openai')
      expect(result).toBeNull()
    })

    it('throws CredentialError on backend failure', async () => {
      const failingBackend: KeytarBackend = {
        setPassword: vi.fn(async () => {}),
        getPassword: vi.fn(async () => { throw new Error('OS denied') }),
        deletePassword: vi.fn(async () => false),
      }
      setBackend(failingBackend)

      await expect(getCredential('openai')).rejects.toSatisfy((err: unknown) => {
        return err instanceof CredentialError && err.category === 'keychain-failure'
      })
    })
  })

  describe('deleteCredential', () => {
    it('returns true when a key was deleted', async () => {
      await setCredential('openai', 'sk-test')
      const result = await deleteCredential('openai')
      expect(result).toBe(true)
    })

    it('returns false when no key existed', async () => {
      const result = await deleteCredential('openai')
      expect(result).toBe(false)
    })

    it('throws CredentialError on backend failure', async () => {
      const failingBackend: KeytarBackend = {
        setPassword: vi.fn(async () => {}),
        getPassword: vi.fn(async () => null),
        deletePassword: vi.fn(async () => { throw new Error('OS denied') }),
      }
      setBackend(failingBackend)

      await expect(deleteCredential('openai')).rejects.toSatisfy((err: unknown) => {
        return err instanceof CredentialError && err.category === 'keychain-failure'
      })
    })
  })
})
