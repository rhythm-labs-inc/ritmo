import {CredentialError} from './errors.js'

const SERVICE_NAME = 'ritmo'
const LEGACY_SERVICE_NAME = 'apprhythm'

export interface KeytarBackend {
  setPassword(service: string, account: string, password: string): Promise<void>
  getPassword(service: string, account: string): Promise<string | null>
  deletePassword(service: string, account: string): Promise<boolean>
}

let _backend: KeytarBackend | null = null

async function getBackend(): Promise<KeytarBackend> {
  if (_backend) return _backend

  try {
    // Dynamic import so tests can inject a mock before this runs
    const keytar = await import('keytar')
    _backend = keytar.default ?? keytar
    return _backend!
  } catch {
    throw new CredentialError(
      'keychain-failure',
      'Could not load keytar for OS keychain access',
      'Ensure keytar native dependencies are installed. In CI/CD, use environment variables instead.',
    )
  }
}

/**
 * Inject a mock backend for testing. Pass `null` to reset to real keytar.
 */
export function setBackend(backend: KeytarBackend | null): void {
  _backend = backend
}

export async function setCredential(provider: string, secret: string): Promise<void> {
  const backend = await getBackend()
  try {
    await backend.setPassword(SERVICE_NAME, provider, secret)
  } catch {
    throw new CredentialError(
      'keychain-failure',
      `Failed to store credential for provider "${provider}"`,
      'Check OS keychain permissions. On Linux, ensure libsecret is installed.',
    )
  }
}

export async function getCredential(provider: string): Promise<string | null> {
  const backend = await getBackend()
  try {
    return await backend.getPassword(SERVICE_NAME, provider) ?? await backend.getPassword(LEGACY_SERVICE_NAME, provider)
  } catch {
    throw new CredentialError(
      'keychain-failure',
      `Failed to read credential for provider "${provider}"`,
      'Check OS keychain permissions. On Linux, ensure libsecret is installed.',
    )
  }
}

export async function deleteCredential(provider: string): Promise<boolean> {
  const backend = await getBackend()
  try {
    // Remove legacy first: if that fails, keep the canonical value authoritative.
    const legacy = await backend.deletePassword(LEGACY_SERVICE_NAME, provider)
    const current = await backend.deletePassword(SERVICE_NAME, provider)
    return legacy || current
  } catch {
    throw new CredentialError(
      'keychain-failure',
      `Failed to delete credential for provider "${provider}"`,
      'Check OS keychain permissions. On Linux, ensure libsecret is installed.',
    )
  }
}
