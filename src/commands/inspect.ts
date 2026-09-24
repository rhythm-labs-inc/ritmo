import path from 'node:path'
import {Args, Flags} from '@oclif/core'

import {RitmoCommand} from '../lib/cli/command.js'
import {formatInspection, InspectionError, readInspection} from '../lib/cli/inspect.js'

export default class Inspect extends RitmoCommand {
  static override description = 'Read a Blueprint, configuration, or evidence JSON/YAML file as a redacted field view (does not verify integrity)'
  static override args = {file: Args.string({required: true, description: 'JSON or YAML file to inspect'})}
  static override flags = {
    section: Flags.string({description: 'Show one dot-separated field path, such as delivery.environments'}),
    json: Flags.boolean({description: 'Export the selected value as plain JSON; sensitive fields remain redacted'}),
  }
  static override examples = ['<%= config.bin %> inspect ./app.blueprint.json --section delivery', '<%= config.bin %> inspect ./evidence/evidence-manifest.json']
  async run(): Promise<void> {
    const {args, flags} = await this.parse(Inspect)
    const file = path.resolve(args.file)
    try {
      const data = await readInspection(file, flags.section)
      if (flags.json) this.log(JSON.stringify(data, null, 2))
      else this.human(formatInspection(data, `Inspect: ${file}${flags.section ? ` → ${flags.section}` : ''}`))
    } catch (error) {
      if (error instanceof InspectionError) this.error(`[${error.category}] ${error.message}\n  Hint: ${error.hint}`, {exit: 1})
      throw error
    }
  }
}
