import {configFilePath} from '../../lib/naming.js'
import {Flags} from '@oclif/core'

import {RitmoCommand} from '../../lib/cli/command.js'
import {formatInspection} from '../../lib/cli/inspect.js'
import {formatConfigSummary} from '../../lib/cli/config-summary.js'
import {ConfigLoadError, loadConfig} from '../../lib/config-loader.js'
import {redactSensitiveFields} from '../../lib/mcp/redaction.js'

export default class ConfigShow extends RitmoCommand {
  static override description = 'Show the effective configuration with defaults and sensitive fields redacted'
  static override flags = {
    json: Flags.boolean({description: 'Export the redacted effective configuration as plain JSON', exclusive: ['verbose']}),
    verbose: Flags.boolean({description: 'Show all effective configuration fields, with sensitive fields redacted'}),
  }
  async run(): Promise<void> {
    const {flags} = await this.parse(ConfigShow)
    try {
      const loaded = await loadConfig()
      const config = redactSensitiveFields(loaded)
      if (flags.json) this.log(JSON.stringify(config, null, 2))
      else if (flags.verbose) this.human(formatInspection(config, `Configuration: ${configFilePath()}`, 'Saved settings with defaults · sensitive fields redacted · connection not checked'))
      else this.human(formatConfigSummary(loaded, configFilePath()))
    } catch (error) {
      if (error instanceof ConfigLoadError) this.error(`[config] ${error.message}`, {exit: 1})
      throw error
    }
  }
}
