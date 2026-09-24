export type CredentialErrorCategory =
  | 'unsupported-provider'
  | 'missing-provider'
  | 'keychain-failure'
  | 'missing-credential'
  | 'input-failure'

export class CredentialError extends Error {
  constructor(
    public readonly category: CredentialErrorCategory,
    message: string,
    public readonly hint?: string,
  ) {
    super(message)
    this.name = 'CredentialError'
  }
}
