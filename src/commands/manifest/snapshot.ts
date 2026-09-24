import {manifestFilePath} from '../../lib/naming.js'
import {authForServer} from '../../lib/mcp/connection.js'
import {writeFile} from 'node:fs/promises'
import path from 'node:path'

import {Flags} from '@oclif/core'

import {RitmoCommand} from '../../lib/cli/command.js'

import {ConfigLoadError, loadConfig} from '../../lib/config-loader.js'
import type {AppRhythmConfig} from '../../lib/config-schema.js'
import {DEFAULT_MANIFEST_FILE, manifestFromContext, stableStringify} from '../../lib/manifest/snapshot.js'
import {DEFAULT_TIMEOUT_MS, McpClient} from '../../lib/mcp/client.js'
import {McpError} from '../../lib/mcp/errors.js'
import {collectContext} from '../../lib/validate/context.js'

export default class ManifestSnapshot extends RitmoCommand {
  static override description = 'Capture the app manifest (tools, widget resources, server info, listing name) to a git-diffable JSON file'

  static override examples = [
    '<%= config.bin %> manifest snapshot',
    '<%= config.bin %> manifest snapshot --tag submitted-2026-07-17',
    '<%= config.bin %> manifest snapshot --server https://www.example.com/mcp/apps/v1 --out prod.manifest.json',
  ]

  static override flags = {
    server: Flags.string({description: 'MCP server URL (overrides server.url from ritmo.yaml)', helpValue: 'URL'}),
    out: Flags.string({char: 'o', description: `Output file (default: ${DEFAULT_MANIFEST_FILE})`, helpValue: 'FILE'}),
    tag: Flags.string({description: 'Label stored in the manifest (e.g. submitted-2026-07-17)', helpValue: 'TAG'}),
    timeout: Flags.integer({description: `Per-request timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})`, default: DEFAULT_TIMEOUT_MS, helpValue: 'MS'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(ManifestSnapshot)

    let config: AppRhythmConfig | undefined
    try {
      config = await loadConfig(process.cwd())
    } catch (err) {
      if (!(err instanceof ConfigLoadError)) throw err
      if (!flags.server) {
        this.error(`No --server flag provided and could not load ritmo.yaml: ${err.message}\nRun \`ritmo init\` or provide --server <url>.`, {exit: 1})
      }
    }

    const serverUrl = flags.server ?? config!.server.url
    const client = new McpClient({serverUrl, timeoutMs: flags.timeout, auth: authForServer(config, serverUrl)})
    try {
      await client.connect()
      const ctx = await collectContext({client, serverUrl, config, probe: false})
      const manifest = manifestFromContext(ctx, {capturedAt: new Date().toISOString(), tag: flags.tag, config})
      const outPath = path.resolve(process.cwd(), flags.out ?? manifestFilePath())
      await writeFile(outPath, stableStringify(manifest), 'utf8')
      this.human(`wrote ${path.relative(process.cwd(), outPath)}: ${manifest.tools.length} tool${manifest.tools.length === 1 ? '' : 's'}, ${manifest.resources.length} widget resource${manifest.resources.length === 1 ? '' : 's'}${flags.tag ? `, tag ${flags.tag}` : ''}`)
      this.human('Commit it as the record of what was submitted; `ritmo manifest diff` compares the live server against it.')
    } catch (err) {
      if (err instanceof McpError) {
        const hint = err.hint ? `\n  Hint: ${err.hint}` : ''
        this.error(`[${err.category}] ${err.message}${hint}`, {exit: 1})
      }
      throw err
    } finally {
      await client.close()
    }
  }
}
