import {manifestFilePath} from '../../lib/naming.js'
import {authForServer} from '../../lib/mcp/connection.js'
import {readFile} from 'node:fs/promises'
import path from 'node:path'

import {Args, Flags} from '@oclif/core'

import {RitmoCommand} from '../../lib/cli/command.js'

import {ConfigLoadError, loadConfig} from '../../lib/config-loader.js'
import type {AppRhythmConfig} from '../../lib/config-schema.js'
import {type DiffFailOn, diffManifests, diffShouldFail, formatDiff, summarizeChanges} from '../../lib/manifest/diff.js'
import {DEFAULT_MANIFEST_FILE, type Manifest, manifestFromContext, parseManifest} from '../../lib/manifest/snapshot.js'
import {DEFAULT_TIMEOUT_MS, McpClient} from '../../lib/mcp/client.js'
import {McpError} from '../../lib/mcp/errors.js'
import {collectContext} from '../../lib/validate/context.js'

const FAIL_ON: DiffFailOn[] = ['resubmit', 'warn', 'never']

export default class ManifestDiff extends RitmoCommand {
  static override description = 'Compare two manifests (default: the saved snapshot vs the live server) and classify each change: requires resubmission / warn / deploys freely'

  static override examples = [
    '<%= config.bin %> manifest diff                              # ritmo.manifest.json vs live server',
    '<%= config.bin %> manifest diff --fail-on resubmit           # CI gate',
    '<%= config.bin %> manifest diff submitted.json live.json     # two files',
    '<%= config.bin %> manifest diff --json',
  ]

  static override args = {
    before: Args.string({description: `Baseline manifest file (default: ${DEFAULT_MANIFEST_FILE})`, required: false}),
    after: Args.string({description: 'Manifest file to compare (default: capture the live server)', required: false}),
  }

  static override flags = {
    server: Flags.string({description: 'MCP server URL to capture as "after" (overrides server.url)', helpValue: 'URL'}),
    json: Flags.boolean({description: 'Print changes as JSON'}),
    'fail-on': Flags.string({description: `Exit 1 when a change of this class or worse exists: ${FAIL_ON.join(', ')} (default: never)`, default: 'never', helpValue: 'CLASS'}),
    timeout: Flags.integer({description: `Per-request timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})`, default: DEFAULT_TIMEOUT_MS, helpValue: 'MS'}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(ManifestDiff)
    const failOn = flags['fail-on'] as DiffFailOn
    if (!FAIL_ON.includes(failOn)) this.error(`Unsupported --fail-on "${flags['fail-on']}". Use one of: ${FAIL_ON.join(', ')}`, {exit: 1})

    const beforePath = path.resolve(process.cwd(), args.before ?? manifestFilePath())
    const before = await this.readManifest(beforePath)

    let after: Manifest
    let afterLabel: string
    if (args.after) {
      const p = path.resolve(process.cwd(), args.after)
      after = await this.readManifest(p)
      afterLabel = path.relative(process.cwd(), p)
    } else {
      let config: AppRhythmConfig | undefined
      try {
        config = await loadConfig(process.cwd())
      } catch (err) {
        if (!(err instanceof ConfigLoadError)) throw err
      }
      const serverUrl = flags.server ?? config?.server.url ?? before.serverUrl
      const client = new McpClient({serverUrl, timeoutMs: flags.timeout, auth: authForServer(config, serverUrl)})
      try {
        await client.connect()
        const ctx = await collectContext({client, serverUrl, config, probe: false})
        after = manifestFromContext(ctx, {capturedAt: new Date().toISOString(), config})
      } catch (err) {
        if (err instanceof McpError) {
          const hint = err.hint ? `\n  Hint: ${err.hint}` : ''
          this.error(`[${err.category}] ${err.message}${hint}`, {exit: 1})
        }
        throw err
      } finally {
        await client.close()
      }
      afterLabel = `live ${serverUrl}`
    }

    const changes = diffManifests(before, after)
    if (flags.json) {
      this.log(JSON.stringify({before: path.relative(process.cwd(), beforePath), after: afterLabel, summary: summarizeChanges(changes), changes}, null, 2))
    } else {
      this.human(formatDiff(changes, {before: `${path.relative(process.cwd(), beforePath)}${before.tag ? ` (${before.tag})` : ''}`, after: afterLabel}))
    }
    if (diffShouldFail(changes, failOn)) this.exit(1)
  }

  private async readManifest(p: string): Promise<Manifest> {
    let raw: string
    try {
      raw = await readFile(p, 'utf8')
    } catch {
      this.error(`Manifest not found: ${p}\nRun \`ritmo manifest snapshot\` first.`, {exit: 1})
    }
    try {
      return parseManifest(raw, path.relative(process.cwd(), p))
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), {exit: 1})
    }
  }
}
