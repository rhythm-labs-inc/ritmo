export interface SessionMessage {
  answerFindings?: import('../../lib/simulate/source-fidelity').AnswerFinding[]
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  origin?: 'user' | 'widget'
}

export interface ToolCallResult {
  content: unknown
  structuredContent?: Record<string, unknown>
  _meta?: Record<string, unknown>
  isError?: boolean
  [key: string]: unknown
}

export interface TraceEvent {
  toolName: string
  status: 'success' | 'error'
  latencyMs: number
  error?: string
  request?: Record<string, unknown>
  requestMeta?: Record<string, unknown>
  response?: ToolCallResult
  startedAt?: string
  contract?: Array<{rule: string; severity: string; target: string; message: string; hint?: string}>
}

export type RunStatus = 'idle' | 'running' | 'success' | 'error'

export type WidgetLifecycleState =
  | 'idle'
  | 'loading'
  | 'initialized'
  | 'mounted'
  | 'error'
  | 'teardown'

export interface WidgetSource {
  type: 'template' | 'local' | 'inline'
  content: string
  origin: string
  mimeType?: string
}

export type WidgetDisplayMode = 'inline' | 'pip' | 'fullscreen'

/** Mirrors src/lib/simulate/widget/types.ts WidgetInstance */
export interface WidgetInstance {
  id: string
  toolName: string
  toolCallId: string
  source: WidgetSource
  toolInput: Record<string, unknown>
  toolOutput: Record<string, unknown> | undefined
  toolResponseMetadata: Record<string, unknown> | undefined
  toolResult: Record<string, unknown> | undefined
  widgetState: Record<string, unknown> | null
  displayMode: WidgetDisplayMode
  intrinsicHeight?: number
  measuredHeight?: number
  lifecycle: WidgetLifecycleState
  error?: string
  mountedAt: string
}

export type BridgeEventKind =
  | 'request'
  | 'response'
  | 'notification'
  | 'error'
  | 'lifecycle'

export interface BridgeDiagnosticEvent {
  seq: number
  timestamp: string
  kind: BridgeEventKind
  method: string
  summary: string
  detail?: unknown
  durationMs?: number
  error?: string
}

export interface SessionState {
  usage?: import('../../lib/simulate/usage').UsageSummary
  health?: import('../../lib/validate/health').HealthReport
  status: RunStatus
  messages: SessionMessage[]
  trace: TraceEvent[]
  error?: string
  errorCategory?: string
  widgetMessageIndex?: number
  widget: WidgetInstance | null
  widgetDiagnostics: BridgeDiagnosticEvent[]
  server?: {name?: string; toolCount: number; templateCount: number; instructions?: string}
  identity?: {subject: string; session: string; locale?: string} | null
  hostOptions: HostOptions
  harness?: HarnessState
}

export interface HostOptions {
  host: 'chatgpt' | 'mcp-apps'
  echoSetGlobals: boolean
  clipToIntrinsicHeight: boolean
  displayMode: WidgetDisplayMode
  theme: 'light' | 'dark'
  viewport: 'desktop' | 'mobile'
  inlineMaxHeight: number
}

export interface HarnessState {
  source: string
  states: string[]
  activeState: string | null
  tools: string[]
  loadedAt: string
  watching: boolean
  error?: string
}

export interface BridgeRequest {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: Record<string, unknown>
}

export interface BridgeResponse {
  jsonrpc: '2.0'
  id: string | number
  result?: unknown
  error?: {code: number; message: string; data?: unknown}
}

export async function fetchSession(): Promise<SessionState> {
  const res = await fetch('/api/session')
  if (!res.ok) throw new Error(`Failed to fetch session: ${res.status}`)
  return res.json() as Promise<SessionState>
}

export async function submitChat(message: string): Promise<void> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({message}),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({error: 'Unknown error'})) as {error?: string}
    throw new Error(body.error ?? `Request failed: ${res.status}`)
  }
}

export async function resetSession(): Promise<void> {
  const res = await fetch('/api/reset', {method: 'POST'})
  if (!res.ok) throw new Error(`Failed to reset session: ${res.status}`)
}

/** Proxy a JSON-RPC bridge request from the widget iframe to the server-side HostBridge. */
export async function postBridge(request: BridgeRequest): Promise<BridgeResponse> {
  const res = await fetch('/api/widget/bridge', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(request),
  })
  const body = (await res.json().catch(() => null)) as BridgeResponse | null
  if (body) return body
  return {jsonrpc: '2.0', id: request.id, error: {code: -32603, message: `Bridge request failed: ${res.status}`}}
}

/** Tell the server the iframe finished loading. */
export async function postWidgetMounted(): Promise<void> {
  await fetch('/api/widget/mounted', {method: 'POST'}).catch(() => {})
}

export async function postHostOptions(patch: Partial<HostOptions>): Promise<HostOptions> {
  const res = await fetch('/api/host-options', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(patch)})
  if (!res.ok) throw new Error(`Failed to update host options: ${res.status}`)
  return res.json() as Promise<HostOptions>
}

export async function postHarnessState(state: string): Promise<void> {
  await fetch('/api/harness/state', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({state})})
}

export async function postHarnessReload(): Promise<void> {
  await fetch('/api/harness/reload', {method: 'POST'})
}
