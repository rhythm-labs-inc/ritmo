import {authForServer} from '../lib/mcp/connection.js'
import {mkdir, writeFile} from 'node:fs/promises'
import path from 'node:path'

import {Flags} from '@oclif/core'

import {RitmoCommand} from '../lib/cli/command.js'
import {BuilderExperience} from '../lib/cli/builder-experience.js'

import {ConfigLoadError, loadConfig} from '../lib/config-loader.js'
import {DEFAULT_TIMEOUT_MS, McpClient, type RawTool} from '../lib/mcp/client.js'
import {buildSubmissionPackage} from '../lib/package/build.js'

export default class Package extends RitmoCommand {
  static override description = 'Emit the OpenAI submission package (listing, test cases, annotation justifications) from ritmo.yaml'

  static override examples = [
    '<%= config.bin %> package',
    '<%= config.bin %> package --out ./dist/submission',
    '<%= config.bin %> package --no-connect      # config only, do not contact the MCP server',
  ]

  static override flags = {
    out: Flags.string({
      char: 'o',
      description: 'Output directory (default: ./submission)',
      default: './submission',
      helpValue: 'DIR',
    }),
    server: Flags.string({
      description: 'MCP server URL (overrides server.url) — used to read tool annotations',
      helpValue: 'URL',
    }),
    connect: Flags.boolean({
      description: 'Connect to the MCP server to include live tool annotations (use --no-connect to skip)',
      default: true,
      allowNo: true,
    }),
    timeout: Flags.integer({
      description: `Request timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})`,
      default: DEFAULT_TIMEOUT_MS,
      helpValue: 'MS',
    }),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(Package)

    let config
    try {
      config = await loadConfig(process.cwd())
    } catch (err) {
      if (err instanceof ConfigLoadError) {
        this.error(`Could not load ritmo.yaml: ${err.message}\nRun \`ritmo init\` to create a config file.`, {exit: 1})
      }
      throw err
    }

    const serverUrl = flags.server ?? config.server.url
    const view = new BuilderExperience()
    try {
      let tools: RawTool[] | undefined
      if (flags.connect) {
        const client = new McpClient({serverUrl, timeoutMs: flags.timeout, auth: authForServer(config, serverUrl)})
        try {
          view.start('Connect', 'Connecting to MCP server')
          await client.connect()
          view.finish('Connect')
          view.start('Discover', 'Reading tool annotations')
          tools = await client.listToolsRaw()
          view.finish('Discover')
        } catch (err) {
          view.fail()
          this.warn(`Could not read tools from ${serverUrl} (${err instanceof Error ? err.message : String(err)}); building from config only.`)
        } finally {
          await client.close()
        }
      }

      const {files, notes} = buildSubmissionPackage({
        config,
        tools,
        serverUrl,
        generatedAt: new Date().toISOString(),
      })

      const outDir = path.resolve(process.cwd(), flags.out)
      view.start('Package', 'Writing submission material')
      for (const f of files) {
        const abs = path.join(outDir, f.path)
        await mkdir(path.dirname(abs), {recursive: true})
        await writeFile(abs, f.content, 'utf8')
      }
      view.finish('Package')
      view.journey()
      for (const f of files) this.human(`wrote ${path.relative(process.cwd(), path.join(outDir, f.path))}`)
      this.human('Package files created · tests not run · real-host approval not established.')

      if (notes.length > 0) {
        this.human('\nStill missing for a complete submission:')
        for (const n of notes) this.human(`  - ${n}`)
        this.human('\nRun `ritmo validate` for the full checklist.')
      } else {
        this.human('\nPackage complete. Run `ritmo validate --fail-on warn` before submitting.')
      }
    } catch (error) {
      view.fail()
      throw error
    } finally { view.dispose() }
  }
}
