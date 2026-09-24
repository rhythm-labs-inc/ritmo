import {CredentialError} from './errors.js'

const SUPPORTED_PROVIDERS = new Set(['openai'])

export function normalizeProvider(raw: string): string {
  return raw.trim().toLowerCase()
}

export function validateProvider(raw: string): string {
  const provider = normalizeProvider(raw)
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    const supported = [...SUPPORTED_PROVIDERS].join(', ')
    throw new CredentialError(
      'unsupported-provider',
      `Unsupported provider: "${raw}"`,
      `Supported providers: ${supported}`,
    )
  }

  return provider
}

export function getSupportedProviders(): string[] {
  return [...SUPPORTED_PROVIDERS]
}

export function envVarNameForProvider(provider: string): string {
  return `RITMO_${provider.toUpperCase()}_API_KEY`
}
