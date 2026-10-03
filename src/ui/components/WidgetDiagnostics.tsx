import type {BridgeDiagnosticEvent} from '../api/client'

interface WidgetDiagnosticsProps {
  events: BridgeDiagnosticEvent[]
}

const KIND_ICONS: Record<string, string> = {
  request: '→',
  response: '✓',
  notification: '!',
  error: '✗',
  lifecycle: '·',
}

const KIND_COLORS: Record<string, string> = {
  request: 'var(--color-info)',
  response: 'var(--color-success)',
  notification: 'var(--color-warn)',
  error: 'var(--color-error)',
  lifecycle: 'var(--color-text-muted)',
}

export function WidgetDiagnostics({events}: WidgetDiagnosticsProps) {
  return (
    <section className="widget-diagnostics" aria-label="Bridge events">
      <h3 className="diagnostics-header">
        <span>Bridge events</span>
        <span className="diagnostics-count">{events.length}</span>
      </h3>
      {events.length === 0 && <p className="diagnostics-placeholder">No widget events yet</p>}
      <div className="diagnostics-list">
        {events.map((evt) => (
          <div key={evt.seq} className={`diagnostic-event diagnostic-event-${evt.kind}`}>
            <div className="diagnostic-row">
              <span className="diagnostic-icon" aria-label={evt.kind}>{KIND_ICONS[evt.kind] ?? '•'}</span>
              <span
                className="diagnostic-method"
                style={{color: KIND_COLORS[evt.kind] ?? 'inherit'}}
              >
                {evt.method}
              </span>
              {evt.durationMs !== undefined && (
                <span className="diagnostic-duration">{evt.durationMs}ms</span>
              )}
              <span className="diagnostic-time">
                {new Date(evt.timestamp).toLocaleTimeString()}
              </span>
            </div>
            <div className="diagnostic-summary">{evt.summary}</div>
            {evt.error && (
              <div className="diagnostic-error">{evt.error}</div>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
