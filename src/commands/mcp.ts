import {authForServer} from '../lib/mcp/connection.js'
import {BuilderExperience} from '../lib/cli/builder-experience.js'
import {showToolCards} from '../lib/cli/tool-cards.js'
import {RitmoCommand} from '../lib/cli/command.js'
import {Flags} from '@oclif/core'

import {ConfigLoadError, loadConfig} from '../lib/config-loader.js'
import {parseToolArgs} from '../lib/mcp/args.js'
import {McpClient, DEFAULT_TIMEOUT_MS} from '../lib/mcp/client.js'
import {McpError} from '../lib/mcp/errors.js'
import {IDENTITY_FLAG_DESCRIPTIONS, identityFromFlags, identityMeta} from '../lib/mcp/identity.js'
import {logCallResult} from '../lib/mcp/inspector.js'
import {checkResultContract} from '../lib/validate/contract.js'

export default class Mcp extends RitmoCommand {
  static override description = 'Connect to an MCP server, list tools, or dispatch tool calls'

  static override examples = [
    '<%= config.bin %> mcp --list-tools',
    '<%= config.bin %> mcp --list-tools --server http://localhost:2091/mcp',
    '<%= config.bin %> mcp --call my_tool --args \'{"param":"value"}\'',
    '<%= config.bin %> mcp --call my_tool --args-file ./args.json --verbose',
  ]

  static override flags = {
    server: Flags.string({
      description: 'MCP server URL (overrides server.url from ritmo.yaml)',
      helpValue: 'URL',
    }),
    'list-tools': Flags.boolean({
      description: 'List all tools available on the MCP server',
      exclusive: ['call'],
    }),
    interactive: Flags.boolean({description: 'Browse tool details by number in an interactive terminal', dependsOn: ['list-tools']}),
    call: Flags.string({
      description: 'Tool name to call',
      helpValue: 'TOOL_NAME',
      exclusive: ['list-tools'],
    }),
    args: Flags.string({
      description: 'Tool arguments as a JSON string',
      helpValue: 'JSON',
      exclusive: ['args-file'],
      dependsOn: ['call'],
    }),
    'args-file': Flags.string({
      description: 'Path to a JSON file containing tool arguments',
      helpValue: 'PATH',
      exclusive: ['args'],
      dependsOn: ['call'],
    }),
    timeout: Flags.integer({
      description: `Request timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})`,
      helpValue: 'MS',
      default: DEFAULT_TIMEOUT_MS,
    }),
    verbose: Flags.boolean({
      char: 'v',
      description: 'Print full request/response JSON for each tool call',
    }),
    subject: Flags.string({description: IDENTITY_FLAG_DESCRIPTIONS.subject, helpValue: 'ID', dependsOn: ['call']}),
    'new-user': Flags.boolean({description: IDENTITY_FLAG_DESCRIPTIONS['new-user'], dependsOn: ['call']}),
    'no-identity': Flags.boolean({description: IDENTITY_FLAG_DESCRIPTIONS['no-identity'], dependsOn: ['call']}),
    'forge-subject': Flags.string({description: IDENTITY_FLAG_DESCRIPTIONS['forge-subject'], helpValue: 'ID', dependsOn: ['call'], exclusive: ['subject', 'new-user', 'no-identity']}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(Mcp)

    // Require a mode flag
    if (!flags['list-tools'] && !flags.call) {
      this.error(
        'Specify a mode: --list-tools or --call <tool-name>',
        {exit: 1},
      )
    }

    // Resolve server URL
    const serverUrl = await this.resolveServerUrl(flags.server)

    const config = await loadConfig().catch((err) => { if (flags.server && err instanceof ConfigLoadError && err.message.startsWith('Config file not found')) return undefined; throw err })
    const client = new McpClient({
      serverUrl,
      auth: authForServer(config, serverUrl),
      timeoutMs: flags.timeout,
    })
    const view = new BuilderExperience({enabled: Boolean(flags['list-tools'])})

    try {
      // Connect and handshake
      if (flags['list-tools']) view.start('Connect', 'Connecting to MCP server')
      else this.human(`Connecting to ${serverUrl}…`)
      await client.connect()
      view.finish('Connect')
      if (!flags['list-tools']) this.human('Connected. MCP handshake successful.')

      if (flags['list-tools']) {
        view.start('Discover', 'Discovering tools')
        const tools = await client.listToolsRaw()
        view.finish('Discover')
        view.settle(`${client.getServerInfo().name ?? 'MCP app'} / local discovery`)
        view.journey()
        view.dispose()
        await showToolCards(tools, flags.interactive, (text) => this.human(text))
      } else if (flags.call) {
        const identity = identityFromFlags(flags)
        if (flags['forge-subject']) this.warn(`Forging openai/subject=${flags['forge-subject']} — the server must NOT treat this as authorisation.`)
        await this.runCallTool(client, flags.call, flags.args, flags['args-file'], flags.verbose ?? false, identity ? identityMeta(identity) : undefined)
      }
    } catch (err) {
      view.fail()
      view.dispose()
      this.handleError(err)
    } finally {
      view.dispose()
      await client.close()
    }
  }

  private async resolveServerUrl(serverFlag: string | undefined): Promise<string> {
    if (serverFlag) return serverFlag

    try {
      const config = await loadConfig(process.cwd())
      return config.server.url
    } catch (err) {
      if (err instanceof ConfigLoadError) {
        this.error(
          `No --server flag provided and could not load ritmo.yaml: ${err.message}\n` +
          'Run `ritmo init` to create a config, or provide --server <url>.',
          {exit: 1},
        )
      }

      throw err
    }
  }

  private async runCallTool(
    client: McpClient,
    toolName: string,
    argsJson: string | undefined,
    argsFile: string | undefined,
    verbose: boolean,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    // Validate tool exists
    this.human('\nDiscovering tools…')
    const tools = await client.listTools()
    const toolNames = tools.map((t) => t.name)

    if (!toolNames.includes(toolName)) {
      throw new McpError(
        'tool-not-found',
        `Tool "${toolName}" not found on this server`,
        `Available tools: ${toolNames.length > 0 ? toolNames.join(', ') : '(none)'}`,
      )
    }

    // Parse args
    const args = await parseToolArgs(argsJson, argsFile)

    // Dispatch call with timing
    this.human(`\nCalling tool "${toolName}"…`)
    if (meta) this.human(`  _meta: ${JSON.stringify(meta)}`)
    const start = Date.now()
    let result: Awaited<ReturnType<McpClient['callTool']>>
    let callError: string | undefined

    try {
      result = await client.callTool(toolName, args, meta ? {meta} : {})
    } catch (err) {
      const latencyMs = Date.now() - start
      const msg = err instanceof McpError ? err.message : String(err)
      callError = msg

      const lines = logCallResult({
        toolName,
        request: args,
        error: callError,
        latencyMs,
        verbose,
      })
      for (const line of lines) this.human(line)

      throw err
    }

    const latencyMs = Date.now() - start
    const lines = logCallResult({
      toolName,
      request: args,
      response: result,
      latencyMs,
      verbose,
    })
    for (const line of lines) this.human(line)

    // Runtime contract checks (docs/apps-sdk-contract.md §4)
    const descriptor = tools.find((t) => t.name === toolName)
    const findings = checkResultContract({name: toolName, outputSchema: descriptor?.outputSchema}, result)
    if (findings.length > 0) {
      this.human('  contract:')
      for (const f of findings) {
        this.human(`    ${f.severity.toUpperCase().padEnd(4)} ${f.rule}: ${f.message}`)
        if (f.hint) this.human(`         → ${f.hint}`)
        if (f.severity === 'fail') this.human(`      Location: ${toolName} · ${f.rule} (source file/line unavailable)\n      Expected: ${f.hint ?? 'satisfy the reported result contract rule'}\n      Received: ${f.message}\n      Impact: this tool result does not satisfy the checked contract.`)
      }
    } else {
      this.human('  contract: ok')
    }
  }

  private handleError(err: unknown): never {
    if (err instanceof McpError) {
      const hint = err.hint ? `\n  Hint: ${err.hint}` : ''
      this.error(`[${err.category}] ${err.message}${hint}`, {exit: 1})
    }

    throw err
  }
}
