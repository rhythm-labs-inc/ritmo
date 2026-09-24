import {McpAuthPanel} from './components/McpAuthPanel'
import {useCallback, useEffect, useRef, useState} from 'react'

import {type SessionState, fetchSession, resetSession, submitChat} from './api/client'
import {ConversationWidget} from './components/ConversationWidget'
import {SmokeDraft} from './components/SmokeDraft'
import {ChatInput} from './components/ChatInput'
import {HarnessView} from './components/HarnessView'
import {HostControls} from './components/HostControls'
import {MessageThread} from './components/MessageThread'
import {TempoMark} from './components/TempoMark'
import {ToolInspector} from './components/ToolInspector'
import {HealthPanel} from './components/HealthPanel'
import {WidgetDiagnostics} from './components/WidgetDiagnostics'
import {WidgetPanel} from './components/WidgetPanel'

const POLL_INTERVAL_MS = 500

const INITIAL_STATE: SessionState = {
  status: 'idle',
  messages: [],
  trace: [],
  widget: null,
  widgetDiagnostics: [],
  hostOptions: {host: 'chatgpt', echoSetGlobals: true, clipToIntrinsicHeight: true, displayMode: 'inline', theme: 'light', viewport: 'desktop', inlineMaxHeight: 480},
}

/** Poll faster while running (tool calls + widget mounts) and slower when idle (bridge activity still updates state). */
const IDLE_POLL_INTERVAL_MS = 2000

export function App() {
  const [session, setSession] = useState<SessionState>(INITIAL_STATE)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [activeInspectorTab, setActiveInspectorTab] = useState<'tools' | 'widget' | 'diagnostics'>('tools')
  const [widgetPlacement, setWidgetPlacement] = useState<'inline' | 'dedicated'>('inline')
  const widgetTarget = useRef<HTMLDivElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastWidgetId = useRef<string | null>(null)

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  // Poll session state: fast while running, then a slow idle poll so widget-driven
  // changes (bridge calls, sendFollowUpMessage) still show up.
  const startPolling = useCallback((intervalMs: number) => {
    stopPolling()
    pollRef.current = setInterval(async () => {
      try {
        const state = await fetchSession()
        setSession(state)
        if (state.status !== 'running' && intervalMs === POLL_INTERVAL_MS) {
          startPolling(IDLE_POLL_INTERVAL_MS)
        } else if (state.status === 'running' && intervalMs !== POLL_INTERVAL_MS) {
          startPolling(POLL_INTERVAL_MS)
        }
      } catch {
        // silently ignore poll errors
      }
    }, intervalMs)
  }, [stopPolling])

  // Initial load + idle polling
  useEffect(() => {
    fetchSession().then(setSession).catch(() => {})
    startPolling(IDLE_POLL_INTERVAL_MS)
    return () => stopPolling()
  }, [startPolling, stopPolling])

  // Jump to the Widget tab when a new widget mounts
  useEffect(() => {
    const id = session.widget?.id ?? null
    if (id && id !== lastWidgetId.current) {
      setActiveInspectorTab('widget')
    }
    lastWidgetId.current = id
  }, [session.widget?.id])

  async function handleSubmit(message: string) {
    setSubmitError(null)
    try {
      await submitChat(message)
      // Update local state immediately (optimistic)
      setSession((prev) => ({
        ...prev,
        status: 'running',
        messages: [...prev.messages, {role: 'user', content: message, timestamp: Date.now()}],
        trace: [],
        error: undefined,
        errorCategory: undefined,
      }))
      startPolling(POLL_INTERVAL_MS)
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to submit message')
    }
  }

  async function handleReset() {
    stopPolling()
    await resetSession().catch(() => {})
    setSession(INITIAL_STATE)
    setSubmitError(null)
    startPolling(IDLE_POLL_INTERVAL_MS)
  }

  const isRunning = session.status === 'running'
  const hasWidget = Boolean(session.widget)
  const hasDiagnostics = (session.widgetDiagnostics ?? []).length > 0
  const isHarness = Boolean(session.harness)
  const hostOptions = session.hostOptions ?? INITIAL_STATE.hostOptions
  const setHostOptions = (next: SessionState['hostOptions']) => setSession((prev) => ({...prev, hostOptions: next}))
  const widgetWorkspaceFocused = !isHarness && hasWidget && activeInspectorTab === 'widget' && widgetPlacement === 'dedicated'

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand-lockup">
          <TempoMark />
          <h1 className="app-title">
            Ritmo <span>{isHarness ? 'widget harness' : 'simulator'}</span>
          </h1>
        </div>
        <div className="app-header-meta">
          {session.server && (
            <span className="server-info" title={session.server.instructions ?? 'no server instructions'}>
              {session.server.name ?? 'server'} · {session.server.toolCount} tools · {session.server.templateCount} templates
            </span>
          )}
          {session.identity !== undefined && (
            <span className="server-info" title={session.identity ? `openai/session=${session.identity.session}` : 'no identity _meta sent (--no-identity)'}>
              {session.identity ? `subject ${session.identity.subject.replace(/^(?:ritmo|apprhythm)-user-/, '')}` : 'no identity'}
            </span>
          )}
          <span className={`status-badge status-badge--${session.status}`}>
            {session.status}
          </span>
          {hasWidget && (
            <span className="status-badge status-badge--widget">
              widget
            </span>
          )}
          {(session.status === 'success' || session.status === 'error') && (
            <button className="reset-btn" onClick={handleReset}>
              New session
            </button>
          )}
        </div>
      </header>
      <McpAuthPanel />

      <div className={`app-body${widgetWorkspaceFocused ? ' app-body--widget-focus' : ''}`}>
        <div className="chat-panel">
          {isHarness ? (
            <HarnessView harness={session.harness!} widget={session.widget} hostOptions={hostOptions} onHostOptions={setHostOptions} />
          ) : (
            <>
              <MessageThread
                widget={session.widget && <ConversationWidget widget={session.widget} options={hostOptions} inline={widgetPlacement === 'inline'} visible={widgetPlacement === 'inline' || activeInspectorTab === 'widget'} target={widgetTarget} />}
                widgetMessageIndex={session.widgetMessageIndex}
                messages={session.messages}
                usage={session.usage}
                status={session.status}
                error={submitError ?? session.error}
                errorCategory={session.errorCategory}
              />
              <SmokeDraft disabled={session.status !== 'success'} />
              <ChatInput onSubmit={handleSubmit} disabled={isRunning} />
            </>
          )}
        </div>

        <div className="inspector-panel">
          <div className="inspector-tabs">
            <button
              className={`inspector-tab ${activeInspectorTab === 'tools' ? 'inspector-tab--active' : ''}`}
              onClick={() => setActiveInspectorTab('tools')}
            >
              Tools
            </button>
            <button
              className={`inspector-tab ${activeInspectorTab === 'widget' ? 'inspector-tab--active' : ''}`}
              onClick={() => setActiveInspectorTab('widget')}
            >
              Widget
              {hasWidget && <span className="tab-indicator" />}
            </button>
            <button
              className={`inspector-tab ${activeInspectorTab === 'diagnostics' ? 'inspector-tab--active' : ''}`}
              onClick={() => setActiveInspectorTab('diagnostics')}
            >
              Events
              {hasDiagnostics && <span className="tab-badge">{session.widgetDiagnostics.length}</span>}
            </button>
          </div>

          <div className="inspector-content">
            {activeInspectorTab === 'tools' && (
              <ToolInspector trace={session.trace} status={session.status} />
            )}
            {activeInspectorTab === 'widget' && (
              <>
                {!isHarness && <>
                  <label className="widget-placement">Widget preview
                    <select value={widgetPlacement} onChange={(event) => setWidgetPlacement(event.target.value as 'inline' | 'dedicated')}>
                      <option value="inline">Inline in conversation</option>
                      <option value="dedicated">Dedicated widget view</option>
                    </select>
                  </label>
                  <p className="widget-presentation-note">A local approximation of ChatGPT presentation.</p>
                  {hasWidget && <HostControls options={hostOptions} onChange={setHostOptions} />}
                  {hasWidget && widgetPlacement === 'dedicated' && <div className="dedicated-widget-slot" ref={widgetTarget} />}
                </>}
                <WidgetPanel widget={session.widget} hostOptions={hostOptions} frameElsewhere />
              </>
            )}
            {activeInspectorTab === 'diagnostics' && (
              <><HealthPanel health={session.health} />
              <WidgetDiagnostics events={session.widgetDiagnostics ?? []} /></>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
