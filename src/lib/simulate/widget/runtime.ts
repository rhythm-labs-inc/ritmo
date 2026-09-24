/**
 * Widget runtime coordinator.
 *
 * Manages the full widget lifecycle: load → initialize → mount → update → teardown.
 * The runtime is a pure state machine; it does NOT interact with DOM or iframes
 * directly (that is the UI layer's concern). Instead it emits lifecycle state
 * transitions and diagnostic events that the React WidgetPanel consumes.
 */

import type {
  BridgeDiagnosticEvent,
  WidgetLifecycleState,
  WidgetRuntimeState,
  WidgetSource,
} from './types.js'

// ---------------------------------------------------------------------------
// Listener type
// ---------------------------------------------------------------------------

export type RuntimeListener = (state: WidgetRuntimeState) => void
export type DiagnosticListener = (event: BridgeDiagnosticEvent) => void

// ---------------------------------------------------------------------------
// WidgetRuntime
// ---------------------------------------------------------------------------

export class WidgetRuntime {
  private state: WidgetRuntimeState = {
    lifecycle: 'idle',
    source: null,
    widgetState: {},
    error: null,
  }

  private seq = 0
  private readonly listeners = new Set<RuntimeListener>()
  private readonly diagnosticListeners = new Set<DiagnosticListener>()

  // -----------------------------------------------------------------------
  // State accessors
  // -----------------------------------------------------------------------

  getState(): Readonly<WidgetRuntimeState> {
    return {...this.state, widgetState: {...this.state.widgetState}}
  }

  getLifecycle(): WidgetLifecycleState {
    return this.state.lifecycle
  }

  // -----------------------------------------------------------------------
  // Lifecycle transitions
  // -----------------------------------------------------------------------

  /**
   * Begin loading a widget from the given source.
   * Transitions: idle|error|teardown → loading
   */
  load(source: WidgetSource): void {
    this.transition('loading')
    this.state.source = source
    this.state.error = null
    this.emitDiagnostic('lifecycle', 'load', `Loading widget from ${source.type}: ${source.origin}`)
    this.notify()
  }

  /**
   * Mark the widget as initialized (handshake complete).
   * Transitions: loading → initialized
   */
  initialize(): void {
    this.assertLifecycle('loading', 'initialize')
    this.transition('initialized')
    this.emitDiagnostic('lifecycle', 'initialize', 'Widget initialized')
    this.notify()
  }

  /**
   * Mark the widget as mounted and visible.
   * Transitions: initialized → mounted
   */
  mount(): void {
    this.assertLifecycle('initialized', 'mount')
    this.transition('mounted')
    this.emitDiagnostic('lifecycle', 'mount', 'Widget mounted')
    this.notify()
  }

  /**
   * Update the widget state (called when setWidgetState arrives from iframe).
   * Only valid when mounted.
   */
  updateWidgetState(patch: Record<string, unknown>): void {
    if (this.state.lifecycle !== 'mounted') {
      this.emitDiagnostic('error', 'updateWidgetState', `Cannot update state in lifecycle "${this.state.lifecycle}"`)
      return
    }

    this.state.widgetState = {...this.state.widgetState, ...patch}
    this.emitDiagnostic('lifecycle', 'updateWidgetState', `Widget state updated: ${summarize(patch)}`)
    this.notify()
  }

  /**
   * Transition the widget into the error state.
   * Can be called from any state.
   */
  fail(message: string): void {
    this.state.error = message
    this.transition('error')
    this.emitDiagnostic('error', 'fail', message)
    this.notify()
  }

  /**
   * Tear down the widget. Clears source and widget state.
   * Can be called from any non-idle state.
   */
  teardown(): void {
    if (this.state.lifecycle === 'idle') return
    this.transition('teardown')
    this.state.source = null
    this.state.widgetState = {}
    this.state.error = null
    this.emitDiagnostic('lifecycle', 'teardown', 'Widget torn down')
    this.notify()
    // After teardown, return to idle
    this.transition('idle')
    this.notify()
  }

  /**
   * Full reset — equivalent to teardown but can be called from idle too.
   */
  reset(): void {
    this.state = {
      lifecycle: 'idle',
      source: null,
      widgetState: {},
      error: null,
    }
    this.seq = 0
    this.notify()
  }

  // -----------------------------------------------------------------------
  // Subscriptions
  // -----------------------------------------------------------------------

  onStateChange(listener: RuntimeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  onDiagnostic(listener: DiagnosticListener): () => void {
    this.diagnosticListeners.add(listener)
    return () => {
      this.diagnosticListeners.delete(listener)
    }
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private transition(next: WidgetLifecycleState): void {
    this.state.lifecycle = next
  }

  private assertLifecycle(expected: WidgetLifecycleState, action: string): void {
    if (this.state.lifecycle !== expected) {
      throw new Error(
        `Cannot ${action}: expected lifecycle "${expected}" but was "${this.state.lifecycle}"`,
      )
    }
  }

  private notify(): void {
    const snapshot = this.getState()
    for (const fn of this.listeners) {
      try {
        fn(snapshot)
      } catch {
        // listener errors must not break the runtime
      }
    }
  }

  private emitDiagnostic(
    kind: BridgeDiagnosticEvent['kind'],
    method: string,
    summary: string,
    detail?: unknown,
    extra?: Partial<Pick<BridgeDiagnosticEvent, 'durationMs' | 'error'>>,
  ): void {
    const event: BridgeDiagnosticEvent = {
      seq: this.seq++,
      timestamp: new Date().toISOString(),
      kind,
      method,
      summary,
      detail,
      ...extra,
    }

    for (const fn of this.diagnosticListeners) {
      try {
        fn(event)
      } catch {
        // listener errors must not break the runtime
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summarize(obj: unknown): string {
  const json = JSON.stringify(obj)
  return json.length > 200 ? json.slice(0, 200) + '...' : json
}
