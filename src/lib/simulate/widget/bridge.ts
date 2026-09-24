/**
 * Host-bridge adapter.
 *
 * Emulates the ChatGPT Apps SDK host-bridge interface that widgets communicate
 * with via JSON-RPC 2.0 over postMessage. The bridge receives requests from
 * the sandboxed widget iframe, dispatches them to the appropriate handler, and
 * returns responses.
 *
 * Supported bridge methods:
 *   - tools/call          → invokes an MCP tool and returns the FULL result (content, structuredContent, _meta, isError)
 *   - ui/setWidgetState   → updates persisted widget state
 *   - ui/requestDisplayMode → logs display mode request (noop in local sim)
 *   - ui/requestClose     → triggers widget teardown
 *   - ui/sendFollowUpMessage → queues a follow-up user message
 *   - ui/openExternal     → logs external link request
 *   - ui/notifyIntrinsicHeight → logs height notification (noop)
 *
 * Unsupported methods receive a JSON-RPC error response with code -32601.
 */

import type {ToolCallResult} from '../../mcp/client.js'
import type {
  BridgeDiagnosticEvent,
  BridgeMethod,
  BridgeRequest,
  BridgeResponse,
} from './types.js'
import type {WidgetRuntime} from './runtime.js'

// ---------------------------------------------------------------------------
// Handler context — dependencies injected by the simulator
// ---------------------------------------------------------------------------

export interface BridgeHandlerContext {
  /**
   * Call an MCP tool by name. Resolves with the FULL result — widgets are
   * entitled to `structuredContent` and `_meta` (docs/apps-sdk-contract.md §4).
   */
  callTool: (name: string, args: Record<string, unknown>) => Promise<ToolCallResult>
  /** Queue a follow-up user message in the chat thread. */
  sendFollowUp: (prompt: string) => void
  /** Optional hooks so the host can persist/observe UI state beyond the runtime state machine. */
  setWidgetState?: (state: Record<string, unknown>) => void
  requestDisplayMode?: (mode: string) => void
  notifyIntrinsicHeight?: (height: number) => void
  requestClose?: () => void
  openExternal?: (href: string) => void
  /** Current host context for MCP Apps `ui/initialize` (theme, displayMode, …). */
  hostContext?: () => Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Diagnostic listener
// ---------------------------------------------------------------------------

export type BridgeDiagnosticListener = (event: BridgeDiagnosticEvent) => void

// ---------------------------------------------------------------------------
// HostBridge
// ---------------------------------------------------------------------------

export class HostBridge {
  private seq = 0
  private readonly diagnosticListeners = new Set<BridgeDiagnosticListener>()

  constructor(
    private readonly runtime: WidgetRuntime,
    private readonly ctx: BridgeHandlerContext,
  ) {}

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Handle an inbound JSON-RPC request from the widget iframe.
   * Returns the JSON-RPC response to post back.
   */
  async handleRequest(request: BridgeRequest): Promise<BridgeResponse> {
    const start = Date.now()

    // Validate basic JSON-RPC shape
    if (request.jsonrpc !== '2.0' || !request.method || request.id == null) {
      const resp = this.errorResponse(request.id ?? 0, -32600, 'Invalid JSON-RPC request')
      this.emitDiag('error', request.method ?? 'unknown', 'Invalid request', undefined, undefined, 'Invalid JSON-RPC request')
      return resp
    }

    this.emitDiag('request', request.method, summarize(request.params), request.params)

    try {
      const result = await this.dispatch(request.method as BridgeMethod, request.params ?? {})
      const durationMs = Date.now() - start
      const resp: BridgeResponse = {jsonrpc: '2.0', id: request.id, result}
      this.emitDiag('response', request.method, summarize(result), result, durationMs)
      return resp
    } catch (err) {
      const durationMs = Date.now() - start
      const message = err instanceof Error ? err.message : String(err)
      const resp = this.errorResponse(request.id, -32603, message)
      this.emitDiag('error', request.method, message, undefined, durationMs, message)
      return resp
    }
  }

  /**
   * Subscribe to diagnostic events emitted by the bridge.
   */
  onDiagnostic(listener: BridgeDiagnosticListener): () => void {
    this.diagnosticListeners.add(listener)
    return () => {
      this.diagnosticListeners.delete(listener)
    }
  }

  // -----------------------------------------------------------------------
  // Method dispatch
  // -----------------------------------------------------------------------

  private async dispatch(method: BridgeMethod | string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'tools/call':
        return this.handleToolsCall(params)
      case 'ui/setWidgetState':
        return this.handleSetWidgetState(params)
      // MCP Apps standard names (docs/apps-sdk-contract.md §9) alongside the ChatGPT-era ones
      case 'ui/requestDisplayMode':
      case 'ui/request-display-mode':
        return this.handleRequestDisplayMode(params)
      case 'ui/requestClose':
      case 'ui/notifications/request-teardown':
        return this.handleRequestClose()
      case 'ui/sendFollowUpMessage':
        return this.handleSendFollowUp(params)
      case 'ui/message':
        return this.handleUiMessage(params)
      case 'ui/openExternal':
      case 'ui/open-link':
        return this.handleOpenExternal(params)
      case 'ui/notifyIntrinsicHeight':
        return this.handleNotifyIntrinsicHeight(params)
      case 'ui/notifications/size-changed':
        return this.handleNotifyIntrinsicHeight({height: params.height})
      case 'ui/initialize':
        return this.handleUiInitialize()
      case 'ui/notifications/initialized':
        return {ok: true}
      default:
        throw new UnsupportedMethodError(method)
    }
  }

  /** MCP Apps `ui/initialize` → host context (values mirror the shim defaults; the SPA overrides theme/mode/viewport via setGlobals). */
  private handleUiInitialize(): unknown {
    const ctx = this.ctx.hostContext?.() ?? {}
    return {
      protocolVersion: '2025-11-25',
      hostContext: {
        theme: 'light',
        displayMode: 'inline',
        availableDisplayModes: ['inline', 'pip', 'fullscreen'],
        locale: 'en-US',
        timeZone: 'UTC',
        platform: 'web',
        deviceCapabilities: {touch: false, hover: true},
        safeAreaInsets: {top: 0, right: 0, bottom: 0, left: 0},
        containerDimensions: {maxHeight: 480},
        ...ctx,
      },
    }
  }

  /** MCP Apps `ui/message` → treated like a follow-up prompt (text content). */
  private handleUiMessage(params: Record<string, unknown>): {ok: true} {
    const content = params.content
    let text = ''
    if (typeof content === 'string') text = content
    else if (Array.isArray(content)) text = content.map((c) => (typeof c === 'object' && c && 'text' in c ? String((c as {text: unknown}).text) : '')).join('\n')
    else if (typeof params.prompt === 'string') text = params.prompt
    if (text.trim().length > 0) this.ctx.sendFollowUp(text.trim())
    return {ok: true}
  }

  // -----------------------------------------------------------------------
  // Individual handlers
  // -----------------------------------------------------------------------

  private async handleToolsCall(params: Record<string, unknown>): Promise<unknown> {
    const name = params.name as string | undefined
    const args = (params.arguments ?? {}) as Record<string, unknown>

    if (!name || typeof name !== 'string') {
      throw new Error('tools/call requires a "name" parameter')
    }

    // Raw postMessage callers get the bare MCP result. The window.openai shim
    // (RHY-64) wraps it in the ChatGPT envelope on top of this.
    return this.ctx.callTool(name, args)
  }

  private handleSetWidgetState(params: Record<string, unknown>): {ok: true} {
    const state = (params.state ?? params) as Record<string, unknown>
    this.runtime.updateWidgetState(state)
    this.ctx.setWidgetState?.(state)
    return {ok: true}
  }

  private handleRequestDisplayMode(params: Record<string, unknown>): {ok: true; mode: unknown} {
    // Local simulator acknowledges; the SPA may resize the frame (RHY-189)
    const mode = String(params.mode ?? params.displayMode ?? 'inline')
    this.ctx.requestDisplayMode?.(mode)
    return {ok: true, mode}
  }

  private handleRequestClose(): {ok: true} {
    this.runtime.teardown()
    this.ctx.requestClose?.()
    return {ok: true}
  }

  private handleSendFollowUp(params: Record<string, unknown>): {ok: true} {
    const prompt = (params.prompt ?? params.message ?? '') as string
    if (typeof prompt === 'string' && prompt.trim().length > 0) {
      this.ctx.sendFollowUp(prompt.trim())
    }

    return {ok: true}
  }

  private handleOpenExternal(params: Record<string, unknown>): {ok: true; href: unknown} {
    const href = params.href ?? params.url ?? ''
    // Local simulator logs but does not open links
    if (typeof href === 'string') this.ctx.openExternal?.(href)
    return {ok: true, href}
  }

  private handleNotifyIntrinsicHeight(params: Record<string, unknown>): {ok: true; height: unknown} {
    const height = params.height ?? 0
    if (typeof height === 'number') this.ctx.notifyIntrinsicHeight?.(height)
    return {ok: true, height}
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private errorResponse(id: string | number, code: number, message: string): BridgeResponse {
    return {jsonrpc: '2.0', id, error: {code, message}}
  }

  private emitDiag(
    kind: BridgeDiagnosticEvent['kind'],
    method: string,
    summary: string,
    detail?: unknown,
    durationMs?: number,
    error?: string,
  ): void {
    const event: BridgeDiagnosticEvent = {
      seq: this.seq++,
      timestamp: new Date().toISOString(),
      kind,
      method,
      summary,
      detail,
      durationMs,
      error,
    }

    for (const fn of this.diagnosticListeners) {
      try {
        fn(event)
      } catch {
        // listener errors must not break the bridge
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class UnsupportedMethodError extends Error {
  readonly code = -32601

  constructor(method: string) {
    super(`Unsupported bridge method: ${method}`)
    this.name = 'UnsupportedMethodError'
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summarize(obj: unknown): string {
  if (obj === undefined || obj === null) return ''
  const json = JSON.stringify(obj)
  return json.length > 200 ? json.slice(0, 200) + '...' : json
}
