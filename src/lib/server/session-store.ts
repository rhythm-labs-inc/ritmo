import type {UsageSummary} from '../simulate/usage.js'
import type {AnswerFinding} from '../simulate/source-fidelity.js'
import {addHealthObservation, createHealth, type HealthObservation, type HealthReport} from '../validate/health.js'
import type {TraceEvent} from '../simulate/trace.js'
import {type BridgeDiagnosticEvent, DEFAULT_HOST_OPTIONS, type HostOptions, type WidgetInstance} from '../simulate/widget/types.js'

/**
 * Status of the current simulation run.
 */
export type RunStatus = 'idle' | 'running' | 'success' | 'error'

/**
 * Snapshot of the current simulation session state.
 * All state is in-memory and cleared when the process stops.
 */
export interface SessionState {
  usage?: UsageSummary
  health?: HealthReport
  status: RunStatus
  /** Ordered list of messages in the conversation */
  messages: SessionMessage[]
  /** Tool call trace for the most recent run */
  trace: TraceEvent[]
  /** Error message if status is 'error' */
  error?: string
  /** Error category for UI display */
  errorCategory?: string
  /** The currently mounted widget (last widget-bearing tool result), if any */
  widgetMessageIndex?: number
  widget: WidgetInstance | null
  /** Bridge / lifecycle diagnostic events for the current session */
  widgetDiagnostics: BridgeDiagnosticEvent[]
  /** Server-level facts captured at connect (shown in the UI header) */
  server?: {name?: string; toolCount: number; templateCount: number; instructions?: string}
  /** Simulated host identity sent on tools/call (null when --no-identity) */
  identity?: {subject: string; session: string; locale?: string} | null
  /** Host behaviours (echo, clipping, display mode, theme, viewport) */
  hostOptions: HostOptions
  /** Present in standalone widget-harness mode (`ritmo widget`) */
  harness?: HarnessState
}

export interface HarnessState {
  /** What is loaded: a local file path or a ui:// URI (+ server). */
  source: string
  /** Named fixture states; the active one is mounted. */
  states: string[]
  activeState: string | null
  /** Names of canned tools available to callTool. */
  tools: string[]
  /** ISO time of the last (re)load. */
  loadedAt: string
  /** Whether the file watcher is active. */
  watching: boolean
  /** Last load error, if any. */
  error?: string
}

export interface SessionMessage {
  answerFindings?: AnswerFinding[]
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  /** Set when the message was injected by the widget (sendFollowUpMessage) rather than typed. */
  origin?: 'user' | 'widget'
}

let state: SessionState = createInitialState()

function createInitialState(): SessionState {
  return {
    status: 'idle',
    messages: [],
    trace: [],
    widget: null,
    widgetDiagnostics: [],
    hostOptions: {...DEFAULT_HOST_OPTIONS},
  }
}

export function getSessionState(): SessionState {
  return state
}

export function setRunning(): void {
  state.status = 'running'
  state.trace = []
  state.error = undefined
  state.errorCategory = undefined
}

export function addUserMessage(content: string, origin: 'user' | 'widget' = 'user'): void {
  state.messages.push({role: 'user', content, timestamp: Date.now(), origin})
}

export function setSuccess(assistantContent: string, trace: TraceEvent[], answerFindings: AnswerFinding[] = []): void {
  state.messages.push({role: 'assistant', content: assistantContent, timestamp: Date.now(), ...(answerFindings.length ? {answerFindings} : {})})
  state.trace = trace
  state.status = 'success'
}

export function setError(message: string, category?: string): void {
  state.status = 'error'
  state.error = message
  state.errorCategory = category
}

export function setWidget(widget: WidgetInstance | null): void {
  if (!widget) state.widgetMessageIndex = undefined
  else if (widget.id !== state.widget?.id) {
    const fromEnd = [...state.messages].reverse().findIndex((message) => message.role === 'user')
    state.widgetMessageIndex = fromEnd < 0 ? undefined : state.messages.length - 1 - fromEnd
  }
  state.widget = widget
}

/** Shallow-patch the mounted widget (widgetState, displayMode, height, lifecycle…). No-op if none. */
export function patchWidget(patch: Partial<WidgetInstance>): WidgetInstance | null {
  if (!state.widget) return null
  state.widget = {...state.widget, ...patch}
  return state.widget
}

export function addWidgetDiagnostic(event: BridgeDiagnosticEvent): void {
  state.widgetDiagnostics.push(event)
}

export function setServerInfo(info: SessionState['server']): void {
  state.server = info
}

export function setIdentity(identity: SessionState['identity']): void {
  state.identity = identity
}

export function setHostOptions(patch: Partial<HostOptions>): HostOptions {
  state.hostOptions = {...state.hostOptions, ...patch}
  return state.hostOptions
}

export function setHarness(h: HarnessState | undefined): void {
  state.harness = h
}

export function resetSession(): void {
  const {server, identity, hostOptions, harness} = state
  state = createInitialState()
  // Server facts, identity, host options and harness config survive a conversation reset.
  state.server = server
  state.identity = identity
  state.hostOptions = hostOptions
  state.harness = harness
}

export function observeHealth(endpoint: string, revision: string | undefined, observation: HealthObservation): void {
  state.health = addHealthObservation(state.health ?? createHealth(endpoint, revision), observation)
}

export function setTrace(trace: TraceEvent[]): void {state.trace = trace}

export function setUsage(usage: UsageSummary): void {state.usage = usage}
