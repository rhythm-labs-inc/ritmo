import type {HostOptions, WidgetInstance} from '../api/client'
import {TempoMark} from './TempoMark'
import {WidgetFrame} from './WidgetFrame'

interface WidgetPanelProps {
  widget: WidgetInstance | null | undefined
  hostOptions?: HostOptions
  /** In harness mode the frame lives in the main pane; the panel only shows data. */
  frameElsewhere?: boolean
}

const LIFECYCLE_LABELS: Record<string, string> = {
  idle: 'No widget',
  loading: 'Loading...',
  initialized: 'Initialized',
  mounted: 'Active',
  error: 'Error',
  teardown: 'Torn down',
}

function Json({label, value}: {label: string; value: unknown}) {
  if (value === undefined || value === null) return null
  return (
    <details className="widget-state-preview">
      <summary>{label}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  )
}

export function WidgetPanel({widget, hostOptions, frameElsewhere}: WidgetPanelProps) {
  if (!widget) {
    return (
      <div className="widget-panel widget-panel-empty">
        <div className="widget-panel-placeholder">
          <TempoMark size={28} />
          <p>No widget active</p>
          <p className="widget-hint">
            A widget appears here when the model calls a tool whose descriptor advertises a
            <code> ui://</code> template (<code>_meta.ui.resourceUri</code>).
          </p>
        </div>
      </div>
    )
  }

  if (widget.lifecycle === 'error') {
    return (
      <div className="widget-panel widget-panel-error">
        <div className="widget-panel-header">
          <span className="widget-status-dot widget-status-error" />
          <span>Widget Error</span>
        </div>
        <div className="widget-error-message">
          <p>{widget.error ?? 'An unknown error occurred while loading the widget.'}</p>
          <p className="widget-error-source">Source: {widget.source.origin}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="widget-panel widget-panel-active">
      <div className="widget-panel-header">
        <span className={`widget-status-dot widget-status-${widget.lifecycle}`} />
        <span>{LIFECYCLE_LABELS[widget.lifecycle] ?? widget.lifecycle}</span>
        <span className="widget-source-badge">{widget.source.type}</span>
        <span className="widget-source-info" title={widget.source.origin}>{widget.toolName}</span>
        <span className="widget-source-badge">{hostOptions?.displayMode ?? widget.displayMode}</span>
        {widget.intrinsicHeight !== undefined && <span className="widget-source-info">h={widget.intrinsicHeight}px</span>}
      </div>
      {!frameElsewhere && (
        <div className="widget-render-area">
          <WidgetFrame widget={widget} hostOptions={hostOptions} />
        </div>
      )}
      <div className="widget-meta">
        <div className="widget-source-info">template: {widget.source.origin}</div>
        <Json label="toolInput" value={widget.toolInput} />
        <Json label="toolOutput (structuredContent)" value={widget.toolOutput} />
        <Json label="toolResponseMetadata (_meta, widget-only)" value={widget.toolResponseMetadata} />
        <Json label="widgetState" value={widget.widgetState} />
      </div>
    </div>
  )
}
