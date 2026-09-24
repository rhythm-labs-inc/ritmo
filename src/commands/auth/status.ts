import {RitmoCommand} from '../../lib/cli/command.js'

import {CredentialError} from '../../lib/credentials/errors.js'
import {envVarNameForProvider, getSupportedProviders} from '../../lib/credentials/providers.js'
import {resolveCredential} from '../../lib/credentials/resolution.js'

export default class Status extends RitmoCommand {
  static override description = 'Show credential status for all supported providers'

  static override examples = [
    '<%= config.bin %> auth status',
  ]

  async run(): Promise<void> {
    try {
      const providers = getSupportedProviders()

      this.human('Credential status:\n')

      for (const provider of providers) {
        const resolved = await resolveCredential(provider)
        const envVar = envVarNameForProvider(provider)

        if (resolved) {
          const masked = maskKey(resolved.value)
          this.human(`  ${provider}`)
          this.human(`    status:  configured`)
          this.human(`    source:  ${resolved.source}`)
          this.human(`    key:     ${masked}`)
        } else {
          this.human(`  ${provider}`)
          this.human(`    status:  not configured`)
          this.human(`    hint:    Run \`ritmo auth set-key --provider ${provider}\` or set ${envVar}`)
        }

        this.human('')
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

/**
 * Mask a key to show only the last 4 characters.
 * Never expose the full value.
 */
function maskKey(key: string): string {
  if (key.length <= 4) return '****'
  return '****' + key.slice(-4)
}
