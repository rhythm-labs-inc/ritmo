import {authForServer} from '../lib/mcp/connection.js'
import path from 'node:path'

import {Args, Flags} from '@oclif/core'

import {RitmoCommand} from '../lib/cli/command.js'

import {ConfigLoadError, loadConfig} from '../lib/config-loader.js'
import type {AppRhythmConfig} from '../lib/config-schema.js'
import {DEFAULT_PORT, startServer} from '../lib/server/fastify.js'
import {WidgetHarness} from '../lib/server/widget-harness.js'
import type {HostOptions} from '../lib/simulate/widget/types.js'

export default class Widget extends RitmoCommand {
  static override description = 'Standalone widget harness: render a widget template with fixture data in the simulator UI — no model, no API key'

  static override examples = [
    '<%= config.bin %> widget ./widget.html --data ./fixture.json',
    '<%= config.bin %> widget ui://notes/list.html --server http://localhost:2091/mcp --data ./states.json',
    '<%= config.bin %> widget ./widget.html --data ./fixture.json --theme dark --viewport mobile --no-echo',
  ]

  static override args = {
    source: Args.string({description: 'Path to a widget HTML file, or a ui:// resource URI (needs --server)', required: true}),
  }

  static override flags = {
    data: Flags.string({char: 'd', description: 'Fixture JSON: {states: {...}, tools: {...}} or a flat {toolInput, toolOutput, …}', helpValue: 'FILE'}),
    server: Flags.string({description: 'MCP server URL — required for ui:// sources; also used for callTool when the fixture has no canned result', helpValue: 'URL'}),
    port: Flags.integer({char: 'p', description: `Local port for the harness UI (default: ${DEFAULT_PORT})`, default: DEFAULT_PORT}),
    open: Flags.boolean({description: 'Open the browser (use --no-open to skip)', default: true, allowNo: true}),
    theme: Flags.string({description: 'Initial theme: light | dark', options: ['light', 'dark']}),
    'display-mode': Flags.string({description: 'Initial display mode: inline | pip | fullscreen', options: ['inline', 'pip', 'fullscreen']}),
    viewport: Flags.string({description: 'Initial viewport: desktop | mobile', options: ['desktop', 'mobile']}),
    echo: Flags.boolean({description: 'Echo the widget\'s own setWidgetState back as openai:set_globals (real-host quirk). Default on; --no-echo to disable', default: true, allowNo: true}),
    clip: Flags.boolean({description: 'Clip the iframe to the last notifyIntrinsicHeight like ChatGPT does. Default on; --no-clip to auto-grow', default: true, allowNo: true}),
    host: Flags.string({description: 'Host profile: chatgpt (window.openai shim) or mcp-apps (Claude-style: standard ui/* JSON-RPC, window.openai accesses logged as mismatches)', default: 'chatgpt', options: ['chatgpt', 'mcp-apps'], helpValue: 'PROFILE'}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Widget)

    if (args.source.startsWith('ui://') && !flags.server) {
      this.error('A ui:// source needs --server <url> to fetch it from.', {exit: 1})
    }

    // Config is optional: use it for server.url / model if present, else a minimal synthetic one.
    let config: AppRhythmConfig
    try {
      config = await loadConfig(process.cwd())
    } catch (err) {
      if (!(err instanceof ConfigLoadError)) throw err
      config = {
        version: 1,
        app: {name: 'widget-harness', description: 'standalone widget harness', icon: '', screenshots: []},
        server: {url: flags.server ?? ''},
        simulate: {model: 'none', default_context: {locale: 'en-US', timezone: 'UTC'}},
        tests: [{file: 'none'}],
      }
    }
    if (flags.server) config = {...config, server: {url: flags.server, auth: authForServer(config, flags.server)}}

    const harness = new WidgetHarness({source: args.source, serverUrl: flags.server ?? (config.server.url || undefined), fixturePath: flags.data, auth: config.server.auth})
    const hostOptions: Partial<HostOptions> = {
      host: flags.host as HostOptions['host'],
      echoSetGlobals: flags.echo,
      clipToIntrinsicHeight: flags.clip,
      ...(flags.theme ? {theme: flags.theme as HostOptions['theme']} : {}),
      ...(flags['display-mode'] ? {displayMode: flags['display-mode'] as HostOptions['displayMode']} : {}),
      ...(flags.viewport ? {viewport: flags.viewport as HostOptions['viewport']} : {}),
    }

    let server: Awaited<ReturnType<typeof startServer>> | undefined
    try {
      server = await startServer({port: flags.port, config, simulator: {harness, hostOptions, identity: null}})
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        this.error(`Port ${flags.port} is already in use.\nTry a different port: ritmo widget ${args.source} --port ${flags.port + 1}`, {exit: 1})
      }
      throw err
    }

    const {url} = server
    this.human(`\nWidget harness: ${args.source.startsWith('ui://') ? args.source : path.relative(process.cwd(), path.resolve(args.source))}`)
    if (flags.data) this.human(`Fixture: ${flags.data} (watching for changes)`)
    this.human(`UI: ${url}\n`)
    this.human('Press Ctrl+C to stop.\n')

    if (flags.open) {
      try {
        const {default: open} = await import('open')
        await open(url)
      } catch {
        this.warn(`Could not open browser automatically. Navigate to ${url} manually.`)
      }
    }

    await new Promise<void>((resolve) => {
      const shutdown = async () => {
        await server?.fastify.close()
        resolve()
      }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
    })
  }
}
