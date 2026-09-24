import {Flags} from '@oclif/core'

import {RitmoCommand} from '../../lib/cli/command.js'

import {CredentialError} from '../../lib/credentials/errors.js'
import {validateProvider} from '../../lib/credentials/providers.js'
import {deleteCredential} from '../../lib/credentials/store.js'

export default class RemoveKey extends RitmoCommand {
  static override description = 'Remove a stored API key from the OS keychain'

  static override examples = [
    '<%= config.bin %> auth remove-key --provider openai',
  ]

  static override flags = {
    provider: Flags.string({
      char: 'p',
      description: 'API provider name',
      required: true,
    }),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(RemoveKey)

    try {
      const provider = validateProvider(flags.provider)

      const deleted = await deleteCredential(provider)

      if (deleted) {
        this.human(`✓ Removed ${provider} key from OS keychain`)
      } else {
        this.human(`No key found for provider "${provider}" in OS keychain. Nothing to remove.`)
      }
    } catch (err) {
      this.handleError(err)
    }
  }

  private handleError(err: unknown): never {
    if (err instanceof CredentialError) {
      const hint = err.hint ? `\n  Hint: ${err.hint}` : ''
      this.error(`[${err.category}] ${err.message}${hint}`, {exit: 1})
    }

    throw err
  }
}
