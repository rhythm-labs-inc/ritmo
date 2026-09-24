import type {ToolCallResult} from '../mcp/client.js'
import type {Finding} from '../validate/types.js'

/**
 * One tool call as seen by the simulate loop. Payloads are captured in full
 * (truncate for display, never at capture — see RHY-62). `_meta` on the
 * response is widget-only; UIs should treat it as sensitive.
 */
export interface TraceEvent {
  toolName: string
  status: 'success' | 'error'
  latencyMs: number
  error?: string
  /** Arguments sent with tools/call. */
  request?: Record<string, unknown>
  /** `_meta` sent with tools/call (identity etc.). */
  requestMeta?: Record<string, unknown>
  /** Full MCP result (content, structuredContent, _meta, isError, extras). */
  response?: ToolCallResult
  /** ISO timestamp when the call started. */
  startedAt?: string
  /** Runtime contract findings for this call (contract/*), if a descriptor was available. */
  contract?: Finding[]
}

export function createTrace(): TraceEvent[] {
  return []
}

export function addTraceEvent(trace: TraceEvent[], event: TraceEvent): void {
  trace.push(event)
}
