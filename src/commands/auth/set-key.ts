import {Flags} from '@oclif/core'

import {RitmoCommand} from '../../lib/cli/command.js'

import {CredentialError} from '../../lib/credentials/errors.js'
import {readSecretInput} from '../../lib/credentials/input.js'
import {validateProvider} from '../../lib/credentials/providers.js'
import {setCredential} from '../../lib/credentials/store.js'

export default class SetKey extends RitmoCommand {
  static override description = 'Store an API key securely in the OS keychain'

  static override examples = [
    '<%= config.bin %> auth set-key --provider openai',
    'echo "sk-abc123" | <%= config.bin %> auth set-key --provider openai',
  ]

  static override flags = {
    provider: Flags.string({
      char: 'p',
      description: 'API provider name',
      required: true,
    }),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(SetKey)

    try {
      const provider = validateProvider(flags.provider)

      const secret = await readSecretInput(`Enter your ${provider} API key: `)

      if (secret.length === 0) {
        this.error('No key provided. Run the command again and enter a key.', {exit: 1})
      }

      await setCredential(provider, secret)

      this.human(`✓ Stored ${provider} key in OS keychain (service: ritmo, account: ${provider})`)
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
