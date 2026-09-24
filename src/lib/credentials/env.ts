import {ritmoEnv} from '../naming.js'

export function getCredentialFromEnv(provider: string): string | undefined {
  const value = ritmoEnv(`${provider.toUpperCase()}_API_KEY`)
  if (value !== undefined && value.trim().length > 0) {
    return value.trim()
  }

  return undefined
}
