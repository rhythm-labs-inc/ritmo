/**
 * Shared types for the widget simulation subsystem.
 *
 * Models the ChatGPT Apps SDK host-bridge interface, widget lifecycle,
 * and diagnostic event types used by the runtime, bridge, loader, and UI.
 */

// ---------------------------------------------------------------------------
// Widget lifecycle
// ---------------------------------------------------------------------------

/** Possible states a widget passes through during its lifecycle. */
export type WidgetLifecycleState =
  | 'idle'
  | 'loading'
  | 'initialized'
  | 'mounted'
  | 'error'
  | 'teardown'

/** Metadata describing the widget source. */
export interface WidgetSource {
  /**
   * How the source was resolved.
   *  - `template`: ui:// resource fetched via resources/read (the current Apps SDK contract)
   *  - `inline`:   HTML embedded in the tool result (legacy)
   *  - `local`:    a localhost/https URL (legacy)
   */
  type: 'template' | 'local' | 'inline'
  /** A URL (for local) or the raw HTML content (for template/inline). */
  content: string
  /** Original reference: the ui:// URI, the URL, or `_meta.openai/outputTemplate`. */
  origin: string
  /** Mime type reported by resources/read (template only). */
  mimeType?: string
}

/** Display modes a widget can request. */
export type WidgetDisplayMode = 'inline' | 'pip' | 'fullscreen'

/**
 * Host behaviours the simulator reproduces (docs/apps-sdk-contract.md §6),
 * each toggleable so a builder can bisect a widget bug. Applies in simulate
 * and standalone (harness) modes.
 */
export interface HostOptions {
  /** Which host to imitate: ChatGPT (window.openai shim) or an MCP Apps host such as Claude (ui/* JSON-RPC only). */
  host: 'chatgpt' | 'mcp-apps'
  /** Re-dispatch openai:set_globals after the widget's own setWidgetState (real-host quirk). */
  echoSetGlobals: boolean
  /** Fix the iframe height to the last notifyIntrinsicHeight (else auto-grow to measured content). */
  clipToIntrinsicHeight: boolean
  displayMode: WidgetDisplayMode
  theme: 'light' | 'dark'
  viewport: 'desktop' | 'mobile'
  /** maxHeight reported to the widget for inline mode, px. */
  inlineMaxHeight: number
}

export const DEFAULT_HOST_OPTIONS: HostOptions = {
  host: 'chatgpt',
  echoSetGlobals: true,
  clipToIntrinsicHeight: true,
  displayMode: 'inline',
  theme: 'light',
  viewport: 'desktop',
  inlineMaxHeight: 480,
}

/** maxHeight per display mode (approximate ChatGPT values; [unverified]). */
export function maxHeightFor(opts: HostOptions): number {
  switch (opts.displayMode) {
    case 'fullscreen': return 2000
    case 'pip': return 640
    default: return opts.inlineMaxHeight
  }
}

/**
 * A widget instance mounted in the simulator after a widget-bearing tool call.
 * Mirrors what the real host hands the iframe via window.openai
 * (docs/apps-sdk-contract.md §6): the template plus the tool's input/output/_meta.
 */
export interface WidgetInstance {
  /** Unique per mount (a new tool call → new instance). */
  id: string
  toolName: string
  toolCallId: string
  source: WidgetSource
  /** Arguments the model passed to the tool. */
  toolInput: Record<string, unknown>
  /** result.structuredContent (model-visible, widget-visible). */
  toolOutput: Record<string, unknown> | undefined
  /** result._meta (widget-only, never model-visible). */
  toolResponseMetadata: Record<string, unknown> | undefined
  /** The full MCP result of the mounting call (content, structuredContent, _meta, isError) — the shim builds the ChatGPT envelope from it. */
  toolResult: Record<string, unknown> | undefined
  /** Persisted UI state from setWidgetState. */
  widgetState: Record<string, unknown> | null
  displayMode: WidgetDisplayMode
  /** Last notifyIntrinsicHeight value, px. */
  intrinsicHeight?: number
  /** Content height measured by the shim (documentElement.scrollHeight), px — for the clipping overlay. */
  measuredHeight?: number
  lifecycle: WidgetLifecycleState
  error?: string
  /** ISO timestamp of the mount. */
  mountedAt: string
}

/** Snapshot of the current widget runtime state. */
export interface WidgetRuntimeState {
  /** Current lifecycle state. */
  lifecycle: WidgetLifecycleState
  /** The widget source if one has been loaded. */
  source: WidgetSource | null
  /** Arbitrary JSON state set by the widget via setWidgetState. */
  widgetState: Record<string, unknown>
  /** Most recent error message, if any. */
  error: string | null
}

// ---------------------------------------------------------------------------
// Host-bridge messages  (JSON-RPC 2.0 style, matching ChatGPT Apps SDK)
// ---------------------------------------------------------------------------

/** Bridge methods that the widget can call on the host. */
export type BridgeMethod =
  | 'tools/call'
  | 'ui/setWidgetState'
  | 'ui/requestDisplayMode'
  | 'ui/requestClose'
  | 'ui/sendFollowUpMessage'
  | 'ui/openExternal'
  | 'ui/notifyIntrinsicHeight'

/** Inbound request from the widget iframe to the host bridge. */
export interface BridgeRequest {
  jsonrpc: '2.0'
  id: string | number
  method: BridgeMethod | string
  params?: Record<string, unknown>
}

/** Outbound response from the host bridge back to the widget iframe. */
export interface BridgeResponse {
  jsonrpc: '2.0'
  id: string | number
  result?: unknown
  error?: {code: number; message: string; data?: unknown}
}

/** Notification (no id) pushed from host to widget. */
export interface BridgeNotification {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Bridge diagnostic events  (consumed by diagnostics panel & tests)
// ---------------------------------------------------------------------------

export type BridgeEventKind =
  | 'request'
  | 'response'
  | 'notification'
  | 'error'
  | 'lifecycle'

export interface BridgeDiagnosticEvent {
  /** Monotonically increasing event id within a session. */
  seq: number
  /** ISO-8601 timestamp. */
  timestamp: string
  kind: BridgeEventKind
  /** Bridge method or lifecycle event name. */
  method: string
  /** Compact summary of the payload (truncated for display). */
  summary: string
  /** Full payload for detailed inspection. */
  detail?: unknown
  /** Duration in ms (for request→response round-trips). */
  durationMs?: number
  /** Error message, if this event represents a failure. */
  error?: string
}

// ---------------------------------------------------------------------------
// Security / sandbox
// ---------------------------------------------------------------------------

/** Content-Security-Policy directives used for the widget sandbox. */
export interface SandboxPolicy {
  /** Whether scripts may execute inside the iframe. */
  allowScripts: boolean
  /** Whether forms may submit. */
  allowForms: boolean
  /** Whether the iframe may navigate its own origin. */
  allowSameOrigin: boolean
  /** Additional sandbox tokens (e.g. 'allow-popups'). */
  extraTokens: string[]
}

/** Default restrictive sandbox policy for widget iframes. */
export const DEFAULT_SANDBOX_POLICY: SandboxPolicy = {
  allowScripts: true, // widgets need JS
  allowForms: true, // widgets may contain forms
  allowSameOrigin: false, // prevent access to host storage
  extraTokens: [],
}
