import {formatUsage, type UsageSummary} from '../lib/simulate/usage.js'
import {Flags} from '@oclif/core'

import {RitmoCommand} from '../lib/cli/command.js'
import path from 'node:path'

import {ConfigLoadError, loadConfig} from '../lib/config-loader.js'
import {BlueprintLoadError, BlueprintProjectionError, loadPluginBlueprint, projectPluginBlueprint} from '../lib/blueprint/index.js'
import {CredentialError} from '../lib/credentials/errors.js'
import {resolveCredential} from '../lib/credentials/resolution.js'
import {McpClient} from '../lib/mcp/client.js'
import {McpError} from '../lib/mcp/errors.js'
import {IDENTITY_FLAG_DESCRIPTIONS, identityFromFlags, identityMeta} from '../lib/mcp/identity.js'
import {DEFAULT_PORT, startServer} from '../lib/server/fastify.js'
import {runHeadlessLoop} from '../lib/simulate/headless-loop.js'
import {formatAssistantResponse, formatTraceOutput} from '../lib/simulate/output.js'
import {OpenAIProvider} from '../lib/simulate/provider/openai.js'

export default class Simulate extends RitmoCommand {
  static override description = 'Start the local ChatGPT App simulator'

  static override examples = [
    '<%= config.bin %> simulate',
    '<%= config.bin %> simulate --port 5000',
    '<%= config.bin %> simulate --headless --message "Show me my open tickets"',
    '<%= config.bin %> simulate --no-ui -m "What is the weather in NYC?"',
  ]

  static override flags = {
    headless: Flags.boolean({
      description: 'Run simulation in headless terminal mode (no browser UI)',
      required: false,
    }),
    'no-ui': Flags.boolean({
      description: 'Run simulation without the browser UI (alias for --headless)',
      required: false,
    }),
    message: Flags.string({
      char: 'm',
      description: 'User message to send to the simulator (headless/no-ui mode only)',
      helpValue: 'TEXT',
    }),
    blueprint: Flags.string({description: 'Use this Blueprint JSON/YAML revision instead of ritmo.yaml', helpValue: 'PATH'}),
    environment: Flags.string({description: 'With --blueprint, project this delivery environment (defaults to the first)', helpValue: 'NAME'}),
    port: Flags.integer({
      char: 'p',
      description: `Local port for the simulator UI server (default: ${DEFAULT_PORT})`,
      default: DEFAULT_PORT,
    }),
    subject: Flags.string({description: IDENTITY_FLAG_DESCRIPTIONS.subject, helpValue: 'ID'}),
    'new-user': Flags.boolean({description: IDENTITY_FLAG_DESCRIPTIONS['new-user']}),
    'no-identity': Flags.boolean({description: IDENTITY_FLAG_DESCRIPTIONS['no-identity']}),
    host: Flags.string({description: 'Host profile: chatgpt (window.openai + openai/* identity) or mcp-apps (Claude-style: ui/* JSON-RPC only, no openai/* _meta)', default: 'chatgpt', options: ['chatgpt', 'mcp-apps'], helpValue: 'PROFILE'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(Simulate)

    // --no-ui is an alias for --headless
    const isHeadless = flags.headless || flags['no-ui']

    if (isHeadless) {
      // Headless / no-UI terminal mode
      this.human('Mode: headless (no browser UI)')

      if (!flags.message || flags.message.trim().length === 0) {
        this.error(
          'A message is required for headless simulation.\n' +
          'Example: ritmo simulate --headless --message "your prompt here"',
          {exit: 1},
        )
      }

      try {
        await this.runHeadless(flags.message, flags)
      } catch (err) {
        this.handleError(err)
      }
    } else {
      // Default: browser UI mode (widget-enabled)
      this.human('Mode: UI (widget-enabled simulator)')

      if (flags.message) {
        this.warn('--message is ignored in UI mode. Use --headless or --no-ui for single-message terminal runs.')
      }

      try {
        await this.runUI(flags.port, flags)
      } catch (err) {
        this.handleError(err)
      }
    }
  }

  private async runUI(port: number, flags: {subject?: string; 'new-user'?: boolean; 'no-identity'?: boolean; host?: string; blueprint?: string; environment?: string}): Promise<void> {
    const config = await this.loadConfigOrFail(flags)
    const host = (flags.host ?? 'chatgpt') as 'chatgpt' | 'mcp-apps'
    // MCP Apps hosts have no openai/* identity _meta
    const identity = host === 'mcp-apps' ? null : identityFromFlags(flags, config.simulate.default_context.locale)
    if (identity) this.human(`Identity: openai/subject=${identity.subject} (session rotates per conversation)`)
    else this.human(host === 'mcp-apps' ? 'Identity: none (mcp-apps host profile sends no openai/* _meta)' : 'Identity: none (--no-identity)')
    this.human(`Host profile: ${host}`)

    let server: Awaited<ReturnType<typeof startServer>> | undefined

    try {
      server = await startServer({port, config, simulator: {identity, hostOptions: {host}}})
    } catch (err: unknown) {
      // Check for port-in-use error
      if (
        err instanceof Error &&
        ('code' in err) &&
        (err as NodeJS.ErrnoException).code === 'EADDRINUSE'
      ) {
        this.error(
          `Port ${port} is already in use.\n` +
          `Try a different port: ritmo simulate --port ${port + 1}`,
          {exit: 1},
        )
      }

      throw err
    }

    const {url} = server

    this.human(`\nRitmo simulator running at ${url}`)
    this.human('Opening browser...\n')
    this.human('Press Ctrl+C to stop the server.\n')

    // Open browser (dynamic import so it can be mocked in tests)
    try {
      const {default: open} = await import('open')
      await open(url)
    } catch {
      this.warn(`Could not open browser automatically. Navigate to ${url} manually.`)
    }

    // Keep process alive until Ctrl+C
    await new Promise<void>((resolve) => {
      process.on('SIGINT', async () => {
        this.human('\nShutting down simulator...')
        await server?.fastify.close()
        resolve()
      })
      process.on('SIGTERM', async () => {
        await server?.fastify.close()
        resolve()
      })
    })
  }

  private async runHeadless(message: string, flags: {subject?: string; 'new-user'?: boolean; 'no-identity'?: boolean; host?: string; blueprint?: string; environment?: string}): Promise<void> {
    // 1. Load config
    const config = await this.loadConfigOrFail(flags)
    const identity = flags.host === 'mcp-apps' ? null : identityFromFlags(flags, config.simulate.default_context.locale)
    const callMeta = identity ? identityMeta(identity) : undefined

    // 2. Resolve OpenAI credential
    const credential = await resolveCredential('openai')
    if (!credential) {
      throw new CredentialError(
        'missing-credential',
        'No OpenAI API key configured',
        'Run `ritmo auth set-key --provider openai` or set RITMO_OPENAI_API_KEY.',
      )
    }

    // 3. Connect to MCP server and list tools
    this.human(`Connecting to MCP server at ${config.server.url}…`)
    const mcpClient = new McpClient({serverUrl: config.server.url, auth: config.server.auth})
    try {
      await mcpClient.connect()
      this.human('MCP connected.')

      const tools = await mcpClient.listTools()
      this.human(`Found ${tools.length} tool${tools.length === 1 ? '' : 's'}.`)

      // 4. Create provider (system prompt includes the server's instructions) and run headless loop
      const provider = new OpenAIProvider({
        apiKey: credential.value,
        model: config.simulate.model,
        instructions: mcpClient.getServerInfo().instructions,
      })

      this.human(`Running simulation with model "${config.simulate.model}"...\n`)

      let observedUsage: UsageSummary | undefined
      let result
      try {result = await runHeadlessLoop({
        onUsage: usage => {observedUsage = usage},
        provider,
        mcpClient,
        tools,
        message,
        callMeta,
      })

      // 5. Print output
      } finally {if (observedUsage) this.human(formatUsage(observedUsage))}
      for (const finding of result.answerFindings) this.human(`Source links need review: ${finding.message}`)
      this.human(formatAssistantResponse(result.assistantResponse))
      const traceOutput = formatTraceOutput(result.trace)
      if (traceOutput) {
        this.human(traceOutput)
      }
    } finally {
      await mcpClient.close()
    }
  }

  private async loadConfigOrFail(flags: {blueprint?: string; environment?: string}) {
    if (flags.blueprint) {
      try {
        const blueprint = await loadPluginBlueprint(path.resolve(process.cwd(), flags.blueprint))
        return projectPluginBlueprint(blueprint, {environment: flags.environment}).config
      } catch (err) {
        if (err instanceof BlueprintLoadError || err instanceof BlueprintProjectionError) {
          this.error(`[blueprint] ${err.message}${err.hint ? `\n  Hint: ${err.hint}` : ''}`, {exit: 1})
        }
        throw err
      }
    }

    try {
      return await loadConfig(process.cwd())
    } catch (err) {
      if (err instanceof ConfigLoadError) {
        this.error(
          `Could not load ritmo.yaml: ${err.message}\n` +
          'Run `ritmo init` to create a config file, or use --blueprint <path>.',
          {exit: 1},
        )
      }

      throw err
    }
  }

  private handleError(err: unknown): never {
    if (err instanceof CredentialError) {
      const hint = err.hint ? `\n  Hint: ${err.hint}` : ''
      this.error(`[${err.category}] ${err.message}${hint}`, {exit: 1})
    }

    if (err instanceof McpError) {
      const hint = err.hint ? `\n  Hint: ${err.hint}` : ''
      this.error(`[${err.category}] ${err.message}${hint}`, {exit: 1})
    }

    if (err instanceof Error && err.message) {
      this.error(`[api-failure] ${err.message}`, {exit: 1})
    }

    throw err
  }
}
