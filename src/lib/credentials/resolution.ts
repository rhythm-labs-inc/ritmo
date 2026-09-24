import {ritmoEnv} from '../naming.js'
import {getCredentialFromEnv} from './env.js'
import {getCredential} from './store.js'

export type CredentialSource = 'env' | 'keychain'

export interface ResolvedCredential {
  value: string
  source: CredentialSource
}

/** When set (any non-empty value), the OS keychain is never consulted — for tests and CI. */
export const NO_KEYCHAIN_ENV = 'RITMO_NO_KEYCHAIN'

export function keychainDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = ritmoEnv('NO_KEYCHAIN', env)
  return v !== undefined && v.trim().length > 0 && v.trim() !== '0' && v.trim().toLowerCase() !== 'false'
}

/**
 * Resolve a credential for a provider with deterministic precedence:
 *   1. Environment variable (RITMO_<PROVIDER>_API_KEY)
 *   2. OS keychain via keytar (skipped when RITMO_NO_KEYCHAIN is set)
 *
 * Env vars take precedence so CI/CD can override local keychain values.
 */
export async function resolveCredential(provider: string): Promise<ResolvedCredential | null> {
  // 1. Check environment variable first
  const envValue = getCredentialFromEnv(provider)
  if (envValue) {
    return {value: envValue, source: 'env'}
  }

  // 2. Fall back to OS keychain (unless disabled — tests must never depend on the developer's keychain)
  if (keychainDisabled()) return null
  const keychainValue = await getCredential(provider)
  if (keychainValue) {
    return {value: keychainValue, source: 'keychain'}
  }

  return null
}
