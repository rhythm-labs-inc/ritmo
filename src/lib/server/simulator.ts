import {mergeUsage} from '../simulate/usage.js'
/**
 * Simulator — the long-lived object behind the browser UI.
 *
 * Owns one MCP connection (reconnects on demand), the raw + typed tool lists,
 * the ui:// template cache, and the widget bridge. Each chat turn runs
 * `runHeadlessLoop`; the `onToolResult` hook mounts a widget when the called
 * tool's descriptor advertises a template (docs/apps-sdk-contract.md §2–§4).
 *
 * The browser talks to it through routes/simulate.ts:
 *   POST /api/chat           → run(message)
 *   POST /api/widget/bridge  → handleBridge(request)   (JSON-RPC from the iframe, proxied by the SPA)
 *   POST /api/reset          → reset()
 */

import type {Tool} from '@modelcontextprotocol/sdk/types.js'

import type {AppRhythmConfig} from '../config-schema.js'
import {CredentialError} from '../credentials/errors.js'
import {resolveCredential} from '../credentials/resolution.js'
import {McpClient, type RawTool, type RawResourceResult} from '../mcp/client.js'
import {resourceObservation} from '../validate/health.js'
import {checkResourceEnvelope} from '../validate/resource-envelope.js'
import {McpError} from '../mcp/errors.js'
import {type HostIdentity, identityMeta, rotateSession} from '../mcp/identity.js'
import {type ToolCallEvent, runHeadlessLoop} from '../simulate/headless-loop.js'
import {OpenAIProvider} from '../simulate/provider/openai.js'
import type {SimulationProvider} from '../simulate/provider/index.js'
import {HostBridge, type BridgeHandlerContext} from '../simulate/widget/bridge.js'
import {TemplateCache, preloadTemplates, resolveWidgetSource, templateUriForTool} from '../simulate/widget/loader.js'
import {WidgetRuntime} from '../simulate/widget/runtime.js'
import type {BridgeRequest, BridgeResponse, HostOptions, WidgetDisplayMode, WidgetInstance, WidgetSource} from '../simulate/widget/types.js'
import {
  observeHealth,
  addUserMessage,
  addWidgetDiagnostic,
  getSessionState,
  patchWidget,
  resetSession,
  setError,
  setHarness,
  setHostOptions,
  setIdentity,
  setRunning,
  setServerInfo,
  setSuccess,
  setTrace,
  setUsage,
  setWidget,
} from './session-store.js'
import type {HarnessLoaded, WidgetHarness} from './widget-harness.js'

export interface SimulatorOptions {
  config: AppRhythmConfig
  /** Injectable for tests. Defaults to OpenAIProvider with the resolved key + server instructions. */
  createProvider?: (apiKey: string, instructions?: string) => SimulationProvider
  /** Injectable for tests. */
  createClient?: (serverUrl: string) => McpClient
  /**
   * Host identity to stamp on tools/call (`openai/subject`, `openai/session`, `openai/locale`).
   * `null` = send nothing. Defaults to null (commands resolve it via resolveIdentity()).
   */
  identity?: HostIdentity | null
  /** Standalone widget harness (`ritmo widget`): mounts fixtures instead of running a model. */
  harness?: WidgetHarness
  /** Initial host behaviour overrides. */
  hostOptions?: Partial<HostOptions>
}

let seq = 0

export class Simulator {
  private client: McpClient | null = null
  private tools: Tool[] = []
  private rawTools: RawTool[] = []
  private templates: TemplateCache | null = null
  private resourceResponses = new Map<string, RawResourceResult>()
  private readonly runtime = new WidgetRuntime()
  private bridge: HostBridge | null = null
  private diagSeq = 0
  /** One provider per conversation so prior turns reach the model (RHY-65). Cleared on reset(). */
  private provider: SimulationProvider | null = null
  private identity: HostIdentity | null

  private harness: WidgetHarness | null
  private harnessLoaded: HarnessLoaded | null = null
  private harnessActiveState: string | null = null

  constructor(private readonly options: SimulatorOptions) {
    this.runtime.onDiagnostic((e) => addWidgetDiagnostic({...e, seq: this.diagSeq++}))
    this.identity = options.identity ?? null
    setIdentity(this.identity ? {subject: this.identity.subject, session: this.identity.session, locale: this.identity.locale} : null)
    if (options.hostOptions) setHostOptions(options.hostOptions)
    this.harness = options.harness ?? null
    // The bridge does not need an MCP connection (harness mode may have none).
    this.bridge = new HostBridge(this.runtime, this.bridgeContext())
    this.bridge.onDiagnostic((e) => addWidgetDiagnostic({...e, seq: this.diagSeq++}))
  }

  get isHarness(): boolean {
    return this.harness !== null
  }

  /** `_meta` for tools/call this conversation. */
  private callMeta(): Record<string, unknown> | undefined {
    const m = identityMeta(this.identity)
    return Object.keys(m).length > 0 ? m : undefined
  }

  // -----------------------------------------------------------------------
  // Connection + discovery
  // -----------------------------------------------------------------------

  /** Connect (or reuse) the MCP client, list tools, index + preload ui:// templates. */
  async ensureConnected(): Promise<void> {
    if (this.client) return
    if (this.connecting) return this.connecting
    this.connecting = this.connect().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  private connecting: Promise<void> | null = null

  private async connect(): Promise<void> {
    const serverUrl = this.options.config.server.url
    const client = this.options.createClient?.(serverUrl) ?? new McpClient({serverUrl, auth: this.options.config.server.auth})
    try {
      await client.connect()
    } catch (err) {
      this.emitLifecycle('error', 'connect', `MCP connect failed: ${err instanceof Error ? err.message : String(err)}`)
      throw err
    }
    this.client = client

    this.tools = await client.listTools()
    this.rawTools = await client.listToolsRaw()
    this.templates = new TemplateCache(async (uri) => {
      const response = await client.readResourceEnvelope(uri)
      this.resourceResponses.set(uri, response)
      this.reportResourceEnvelope(uri, response)
      return response.contents
    })
    const preload = await preloadTemplates(this.rawTools, this.templates)
    for (const [uri, err] of preload) {
      if (err) observeHealth(serverUrl, client.getServerInfo().version, resourceObservation(uri, undefined, getSessionState().hostOptions.host, undefined, String(err)))
      this.emitLifecycle(err ? 'error' : 'lifecycle', 'template', err ? `Failed to preload ${uri}: ${err}` : `Preloaded template ${uri}`)
    }

    const info = client.getServerInfo()
    setServerInfo({name: info.name, toolCount: this.tools.length, templateCount: preload.size, instructions: info.instructions})
  }

  async dropConnection(): Promise<void> {
    const c = this.client
    this.client = null
    this.templates?.clear()
    this.templates = null
    this.resourceResponses.clear()
    if (c) await c.close()
  }

  // -----------------------------------------------------------------------
  // Host options (echo, clipping, display mode, theme, viewport)
  // -----------------------------------------------------------------------

  setHostOptions(patch: Partial<HostOptions>): HostOptions {
    const opts = setHostOptions(patch)
    if (patch.displayMode) patchWidget({displayMode: patch.displayMode})
    if (patch.host) for (const [uri, response] of this.resourceResponses) this.reportResourceEnvelope(uri, response)
    return opts
  }

  private reportResourceEnvelope(uri: string, response: RawResourceResult): void {
    observeHealth(this.options.config.server.url, this.client?.getServerInfo().version, resourceObservation(uri, response, getSessionState().hostOptions.host, this.client?.getServerInfo().protocolVersion))
    const findings = checkResourceEnvelope(response, {uri, host: getSessionState().hostOptions.host, protocolVersion: this.client?.getServerInfo().protocolVersion})
    for (const finding of findings) addWidgetDiagnostic({
      seq: this.diagSeq++, timestamp: new Date().toISOString(),
      kind: finding.severity === 'fail' ? 'error' : 'lifecycle', method: finding.rule,
      summary: `${finding.severity}: ${finding.message} Hint: ${finding.hint} Source: ${finding.source}`, detail: finding,
    })
  }

  // -----------------------------------------------------------------------
  // Standalone harness (ritmo widget)
  // -----------------------------------------------------------------------

  /** Load the harness source + fixture and mount the first (or given) state. */
  async loadHarness(stateName?: string): Promise<void> {
    if (!this.harness) throw new Error('Simulator has no harness attached')
    try {
      this.harnessLoaded = await this.harness.load()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.emitLifecycle('error', 'harness', `Load failed: ${msg}`)
      setHarness({...(getSessionState().harness ?? {source: this.harness.label, states: [], activeState: null, tools: [], loadedAt: new Date().toISOString(), watching: false}), error: msg})
      return
    }
    const states = Object.keys(this.harnessLoaded.fixture.states)
    const active = stateName && states.includes(stateName) ? stateName : (this.harnessActiveState && states.includes(this.harnessActiveState) ? this.harnessActiveState : states[0])
    setHarness({
      source: this.harnessLoaded.label,
      states,
      activeState: active,
      tools: Object.keys(this.harnessLoaded.fixture.tools),
      loadedAt: new Date().toISOString(),
      watching: getSessionState().harness?.watching ?? false,
    })
    this.emitLifecycle('lifecycle', 'harness', `Loaded ${this.harnessLoaded.label} (${states.length} state${states.length === 1 ? '' : 's'})`)
    this.mountHarnessState(active)
  }

  /** Start watching the harness files; on change, reload + remount the active state. */
  watchHarness(): boolean {
    if (!this.harness) return false
    const ok = this.harness.watch(() => {
      this.emitLifecycle('lifecycle', 'harness', 'File changed — reloading')
      void this.loadHarness()
    })
    if (getSessionState().harness) setHarness({...getSessionState().harness!, watching: ok})
    return ok
  }

  /** Mount a named fixture state as the current widget. */
  mountHarnessState(name: string): void {
    if (!this.harnessLoaded) return
    const st = this.harnessLoaded.fixture.states[name]
    if (!st) return
    this.harnessActiveState = name
    const toolResult: Record<string, unknown> = {
      content: [{type: 'text', text: `harness state: ${name}`}],
      ...(st.toolOutput ? {structuredContent: st.toolOutput} : {}),
      ...(st.toolResponseMetadata ? {_meta: st.toolResponseMetadata} : {}),
      isError: false,
    }
    const instance: WidgetInstance = {
      id: `h${++seq}-${Date.now()}`,
      toolName: this.harnessLoaded.fixture.toolName ?? 'harness',
      toolCallId: `harness-${name}`,
      source: this.harnessLoaded.source,
      toolInput: st.toolInput ?? {},
      toolOutput: st.toolOutput ?? undefined,
      toolResponseMetadata: st.toolResponseMetadata ?? undefined,
      toolResult,
      widgetState: st.widgetState ?? null,
      displayMode: getSessionState().hostOptions.displayMode,
      lifecycle: 'loading',
      mountedAt: new Date().toISOString(),
    }
    this.runtime.reset()
    this.runtime.load(instance.source)
    setWidget(instance)
    if (getSessionState().harness) setHarness({...getSessionState().harness!, activeState: name})
  }

  // -----------------------------------------------------------------------
  // Chat turns
  // -----------------------------------------------------------------------

  /**
   * Run one user turn. Resolves when the run has finished; session state is
   * updated as it goes (status running → success|error).
   */
  async run(message: string, origin: 'user' | 'widget' = 'user', signal?: AbortSignal): Promise<void> {
    const priorUsage = getSessionState().usage
    setRunning()
    addUserMessage(message, origin)

    const credential = await resolveCredential('openai')
    if (!credential) {
      setError(
        'No OpenAI API key configured. Run `ritmo auth set-key --provider openai` or set RITMO_OPENAI_API_KEY.',
        'missing-credential',
      )
      return
    }

    try {
      if(signal?.aborted)throw new McpError('cancelled','Simulation cancelled.')
      await this.ensureConnected()
      if(signal?.aborted)throw new McpError('cancelled','Simulation cancelled.')
      if (!this.provider) {
        const instructions = this.client!.getServerInfo().instructions
        this.provider = this.options.createProvider
          ? this.options.createProvider(credential.value, instructions)
          : new OpenAIProvider({apiKey: credential.value, model: this.options.config.simulate.model, instructions, signal})
      }

      const result = await runHeadlessLoop({
        signal,
        onTrace: trace => {setTrace(trace);const event=trace.at(-1);if(event)observeHealth(this.options.config.server.url,this.client?.getServerInfo().version,{stage:'tool-call',state:event.status==='error'?'fail':'pass',tool:event.toolName,detail:event.error??'Tool response received; render and interaction are separate checks.'})},
        onUsage: usage => setUsage(mergeUsage([priorUsage, usage])),
        provider: this.provider,
        mcpClient: this.client!,
        tools: this.tools,
        message,
        continueConversation: true,
        callMeta: this.callMeta(),
        onToolResult: (ev) => this.onToolResult(ev),
      })
      setSuccess(result.assistantResponse, result.trace, result.answerFindings)
    } catch (err) {
      if (err instanceof CredentialError || err instanceof McpError) {
        setError(err.message, err.category)
        if (err instanceof McpError && (err.category === 'connection' || err.category === 'timeout')) {
          await this.dropConnection() // force a reconnect on the next turn
        }
      } else if (err instanceof Error) {
        setError(err.message, 'api-failure')
      } else {
        setError('An unexpected error occurred', 'unknown')
      }
    }
  }

  // -----------------------------------------------------------------------
  // Widget mounting
  // -----------------------------------------------------------------------

  private async onToolResult(ev: ToolCallEvent): Promise<void> {
    const source = await this.sourceFor(ev)
    if (!source) return
    const instance: WidgetInstance = {
      id: `w${++seq}-${Date.now()}`,
      toolName: ev.name,
      toolCallId: ev.toolCallId,
      source,
      toolInput: ev.arguments,
      toolOutput: ev.result.structuredContent,
      toolResponseMetadata: ev.result._meta,
      toolResult: ev.result as Record<string, unknown>,
      widgetState: null,
      displayMode: 'inline',
      lifecycle: 'loading',
      mountedAt: new Date().toISOString(),
    }
    // Reset the runtime state machine for the new instance and mark it loading.
    this.runtime.reset()
    this.runtime.load(source)
    setWidget(instance)
  }

  /** ui:// template from the descriptor first; legacy inline/URL from the result second. */
  private async sourceFor(ev: ToolCallEvent): Promise<WidgetSource | null> {
    const raw = this.rawTools.find((t) => t.name === ev.name)
    const uri = templateUriForTool(raw)
    if (uri && this.templates) {
      try {
        return await this.templates.get(uri)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.emitLifecycle('error', 'template', `Could not load ${uri} for ${ev.name}: ${msg}`)
        return null
      }
    }
    try {
      return resolveWidgetSource(ev.result)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.emitLifecycle('error', 'load', `Legacy widget source rejected for ${ev.name}: ${msg}`)
      return null
    }
  }

  // -----------------------------------------------------------------------
  // Bridge (called from the browser via /api/widget/bridge)
  // -----------------------------------------------------------------------

  async handleBridge(request: BridgeRequest): Promise<BridgeResponse> {
    // Harness telemetry from the shim: natural content height (for the clipping overlay)
    if (request.method === 'apprhythm/measure') {
      const h = (request.params as {height?: unknown} | undefined)?.height
      if (typeof h === 'number') patchWidget({measuredHeight: h})
      return {jsonrpc: '2.0', id: request.id, result: {ok: true}}
    }
    // mcp-apps host profile: the SPA installs a window.openai sentinel that reports every access.
    if (request.method === 'apprhythm/host-mismatch') {
      const p = (request.params ?? {}) as {api?: string; prop?: string}
      this.emitLifecycle('error', 'host-mismatch', `widget accessed ${p.api ?? 'window.openai'}.${p.prop ?? '?'} — not available on MCP Apps hosts (Claude); use ui/* JSON-RPC (docs/apps-sdk-contract.md §9)`)
      return {jsonrpc: '2.0', id: request.id, result: {ok: true}}
    }
    const response = await this.bridge!.handleRequest(request)
    if (['tools/call', 'callTool'].includes(request.method)) observeHealth(this.options.config.server.url, this.client?.getServerInfo().version, {stage: 'first-interaction', state: response.error || (response.result as {isError?: boolean} | undefined)?.isError ? 'fail' : 'pass', template: getSessionState().widget?.source.origin, detail: 'Widget bridge tool interaction observed locally; not a real-host check.'})
    return response
  }

  /** The iframe reported it has mounted (SPA calls this after load). */
  markMounted(): void {
    const w = getSessionState().widget
    if (!w) return
    try {
      if (this.runtime.getLifecycle() === 'loading') this.runtime.initialize()
      if (this.runtime.getLifecycle() === 'initialized') this.runtime.mount()
    } catch {
      // lifecycle already advanced — ignore
    }
    patchWidget({lifecycle: 'mounted'})
    observeHealth(this.options.config.server.url, this.client?.getServerInfo().version, {stage: 'local-render', state: 'pass', template: w.source.origin, detail: 'Iframe load reported; visual correctness and real-host rendering remain unverified.'})
  }

  private bridgeContext(): BridgeHandlerContext {
    return {
      callTool: async (name, args) => {
        // Harness: canned results first
        const canned = this.harnessLoaded?.fixture.tools[name]
        if (canned) {
          patchWidget({toolOutput: canned.structuredContent ?? getSessionState().widget?.toolOutput, toolResponseMetadata: canned._meta ?? getSessionState().widget?.toolResponseMetadata, toolResult: canned as Record<string, unknown>})
          return canned
        }
        if (this.harness && !this.options.config.server.url) {
          throw new Error(`No canned result for "${name}" in the fixture (add it under "tools") and no --server to call`)
        }
        await this.ensureConnected()
        const meta = this.callMeta()
        const result = await this.client!.callTool(name, args, meta ? {meta} : {})
        // A widget-initiated call may itself carry a template → re-mount, like the host does.
        const raw = this.rawTools.find((t) => t.name === name)
        if (templateUriForTool(raw)) {
          await this.onToolResult({toolCallId: `widget-${Date.now()}`, name, arguments: args, result})
        } else {
          // Same widget stays mounted; refresh its data so window.openai globals update.
          patchWidget({
            toolOutput: result.structuredContent ?? getSessionState().widget?.toolOutput,
            toolResponseMetadata: result._meta ?? getSessionState().widget?.toolResponseMetadata,
            toolResult: result as Record<string, unknown>,
          })
        }
        return result
      },
      sendFollowUp: (prompt) => {
        // Queue a new turn as if the user typed it (origin: widget). Don't await — the bridge
        // response must return to the iframe promptly. In harness mode there is no model: log it.
        if (this.harness) {
          addUserMessage(prompt, 'widget')
          this.emitLifecycle('lifecycle', 'sendFollowUpMessage', `(harness) widget asked to send: "${prompt}"`)
          return
        }
        if (getSessionState().status !== 'running') {
          void this.run(prompt, 'widget')
        }
      },
      setWidgetState: (state) => {
        patchWidget({widgetState: state})
      },
      requestDisplayMode: (mode) => {
        this.setHostOptions({displayMode: mode as WidgetDisplayMode})
      },
      notifyIntrinsicHeight: (height) => {
        patchWidget({intrinsicHeight: height})
      },
      requestClose: () => {
        patchWidget({lifecycle: 'teardown'})
        setWidget(null)
      },
      hostContext: () => {
        const o = getSessionState().hostOptions
        return {
          theme: o.theme,
          displayMode: o.displayMode,
          platform: o.viewport === 'mobile' ? 'mobile' : 'web',
          deviceCapabilities: {touch: o.viewport === 'mobile', hover: o.viewport !== 'mobile'},
          containerDimensions: {maxHeight: o.displayMode === 'fullscreen' ? 2000 : o.displayMode === 'pip' ? 640 : o.inlineMaxHeight},
        }
      },
    }
  }

  // -----------------------------------------------------------------------
  // Reset / shutdown
  // -----------------------------------------------------------------------

  /** New conversation: clear messages/trace/widget. Keeps the MCP connection + template cache. */
  reset(): void {
    resetSession()
    this.runtime.reset()
    this.provider = null
    this.diagSeq = 0
    // New conversation, same user: fresh openai/session, same openai/subject.
    if (this.identity) {
      this.identity = rotateSession(this.identity)
      setIdentity({subject: this.identity.subject, session: this.identity.session, locale: this.identity.locale})
    }
  }

  async close(): Promise<void> {
    this.harness?.close()
    await this.dropConnection()
  }

  private emitLifecycle(kind: 'lifecycle' | 'error', method: string, summary: string): void {
    addWidgetDiagnostic({seq: this.diagSeq++, timestamp: new Date().toISOString(), kind, method, summary})
  }
}
