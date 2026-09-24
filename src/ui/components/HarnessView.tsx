import {type HarnessState, type HostOptions, type WidgetInstance, postHarnessReload, postHarnessState} from '../api/client'
import {HostControls} from './HostControls'
import {WidgetFrame} from './WidgetFrame'

interface HarnessViewProps {
  harness: HarnessState
  widget: WidgetInstance | null
  hostOptions: HostOptions
  onHostOptions: (next: HostOptions) => void
}

/**
 * Main pane in `apprhythm widget` mode: the widget rendered large, a fixture-state
 * picker, reload, and the host-behaviour toggles.
 */
export function HarnessView({harness, widget, hostOptions, onHostOptions}: HarnessViewProps) {
  return (
    <div className="harness-view">
      <div className="harness-bar">
        <span className="harness-source" title={harness.source}>{harness.source}</span>
        {harness.states.length > 1 && (
          <label>
            state
            <select value={harness.activeState ?? ''} onChange={(e) => void postHarnessState(e.target.value)}>
              {harness.states.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
        )}
        <button className="reset-btn" onClick={() => void postHarnessReload()}>Reload</button>
        <span className="server-info">{harness.watching ? 'watching files' : 'not watching'} · loaded {new Date(harness.loadedAt).toLocaleTimeString()}</span>
        {harness.tools.length > 0 && <span className="server-info" title={harness.tools.join(', ')}>{harness.tools.length} canned tool{harness.tools.length === 1 ? '' : 's'}</span>}
      </div>
      <HostControls options={hostOptions} onChange={onHostOptions} />
      {harness.error && <div className="message message--assistant"><div className="message-content trace-error">Load error: {harness.error}</div></div>}
      <div className={`harness-stage harness-stage--${hostOptions.viewport} harness-stage--${hostOptions.displayMode}`}>
        {widget ? <WidgetFrame widget={widget} hostOptions={hostOptions} /> : <p className="empty-state">No widget mounted — check the fixture / template.</p>}
      </div>
    </div>
  )
}
