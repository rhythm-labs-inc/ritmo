import {useEffect, useRef} from 'react'
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
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({behavior: 'smooth'})
  }, [events.length])

  if (events.length === 0) {
    return (
      <div className="widget-diagnostics widget-diagnostics-empty">
        <p className="diagnostics-placeholder">No widget events yet</p>
      </div>
    )
  }

  return (
    <div className="widget-diagnostics">
      <div className="diagnostics-header">
        <span>Bridge Events</span>
        <span className="diagnostics-count">{events.length}</span>
      </div>
      <div className="diagnostics-list">
        {events.map((evt) => (
          <div key={evt.seq} className={`diagnostic-event diagnostic-event-${evt.kind}`}>
            <div className="diagnostic-row">
              <span className="diagnostic-icon">{KIND_ICONS[evt.kind] ?? '•'}</span>
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
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
