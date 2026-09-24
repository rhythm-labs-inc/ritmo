import type {TraceEvent} from '../api/client'

interface ToolInspectorProps {
  trace: TraceEvent[]
  status: string
}

const SENSITIVE_KEY = /token|apikey|authorization|password|secret/i

/** Same rule as src/lib/mcp/redaction.ts — values under sensitive-looking keys are masked. */
function redact(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(redact)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redact(v)
  }
  return out
}

function Json({label, value, sensitive}: {label: string; value: unknown; sensitive?: boolean}) {
  if (value === undefined) return null
  const shown = sensitive ? redact(value) : value
  return (
    <details className="trace-payload">
      <summary>{label}{sensitive ? ' (widget-only, redacted)' : ''}</summary>
      <pre>{JSON.stringify(shown, null, 2)}</pre>
    </details>
  )
}

export function ToolInspector({trace, status}: ToolInspectorProps) {
  if (trace.length === 0 && status !== 'running') {
    return (
      <div className="tool-inspector tool-inspector--empty">
        <h2 className="inspector-title">Tool Inspector</h2>
        <p className="empty-state">Tool calls will appear here during simulation.</p>
      </div>
    )
  }

  return (
    <div className="tool-inspector">
      <h2 className="inspector-title">Tool Inspector</h2>

      {status === 'running' && trace.length === 0 && (
        <p className="inspector-waiting">Waiting for tool calls…</p>
      )}

      <div className="trace-list">
        {trace.map((event, i) => (
          <div
            key={i}
            className={`trace-event trace-event--${event.status}`}
          >
            <div className="trace-header">
              <span className="trace-status-icon">{event.status === 'success' ? '✓' : '✗'}</span>
              <span className="trace-tool-name">{event.toolName}</span>
              <span className="trace-latency">{event.latencyMs}ms</span>
            </div>
            {event.error && (
              <div className="trace-error">{event.error}</div>
            )}
            {event.contract?.map((f, j) => (
              <div key={j} className={`trace-contract trace-contract--${f.severity}`} title={f.hint}>
                {f.severity === 'fail' ? '✗' : '!'} {f.rule}: {f.message}
              </div>
            ))}
            <Json label="arguments" value={event.request} />
            <Json label="request _meta (identity)" value={event.requestMeta} />
            <Json label="content" value={event.response?.content} />
            <Json label="structuredContent" value={event.response?.structuredContent} />
            <Json label="_meta" value={event.response?._meta} sensitive />
          </div>
        ))}
      </div>
    </div>
  )
}
