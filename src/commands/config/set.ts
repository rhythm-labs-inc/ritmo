import {configFilePath} from '../../lib/naming.js'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {Args, Flags} from '@oclif/core'
import {RitmoCommand} from '../../lib/cli/command.js'
import {promptServerUrl, saveServerUrl, updateServerUrlText} from '../../lib/config-setup.js'
import {McpError} from '../../lib/mcp/errors.js'

export default class ConfigSet extends RitmoCommand {
  static override description = 'Update the MCP server URL in ritmo.yaml'
  static override examples = ['<%= config.bin %> config set server.url https://example.com/mcp', '<%= config.bin %> config set server.url http://localhost:3000/mcp --skip-check --no-interactive']
  static override args = {key: Args.string({required: true, options: ['server.url']}), value: Args.string({required: true})}
  static override flags = {
    'skip-check': Flags.boolean({description: 'Explicitly save for later without checking the connection'}),
    'no-interactive': Flags.boolean({description: 'Do not prompt for confirmation or recovery'}),
  }
  async run(): Promise<void> {
    const {args, flags} = await this.parse(ConfigSet)
    try {
      const file = configFilePath(process.cwd())
      const original = await readFile(file, 'utf8')
      updateServerUrlText(original, args.value) // Validate before doing network work.
      const url = await promptServerUrl({url: args.value, skipCheck: flags['skip-check'], interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY && !flags['no-interactive']), report: (message) => this.human(message)})
      if (configFilePath() !== file) throw new McpError('naming-conflict', 'Configuration selection changed during setup. Retry against the current file.')
      await saveServerUrl(file, original, url)
      this.human(`Updated server.url in ${path.basename(file)}`)
    } catch (error) { this.handleError(error) }
  }
  private handleError(error: unknown): never {
    if (error instanceof McpError) this.error(`[${error.category}] ${error.message}\n  Hint: ${error.hint ?? 'Retry setup.'}`, {exit: 1})
    this.error('[config] Could not read or update ritmo.yaml. Run `ritmo init` if it does not exist; otherwise check file permissions.', {exit: 1})
  }
}
