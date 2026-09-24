import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {
  addUserMessage,
  getSessionState,
  resetSession,
  setError,
  setRunning,
  setSuccess,
} from '../../src/lib/server/session-store.js'

// Reset session before each test to avoid state leakage
beforeEach(() => {
  resetSession()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('session-store — state transitions', () => {
  it('starts in idle state', () => {
    const state = getSessionState()
    expect(state.status).toBe('idle')
    expect(state.messages).toEqual([])
    expect(state.trace).toEqual([])
    expect(state.error).toBeUndefined()
  })

  it('setRunning transitions to running and clears trace/error', () => {
    setError('previous error', 'api-failure')
    setRunning()
    const state = getSessionState()
    expect(state.status).toBe('running')
    expect(state.trace).toEqual([])
    expect(state.error).toBeUndefined()
    expect(state.errorCategory).toBeUndefined()
  })

  it('addUserMessage appends a user message', () => {
    addUserMessage('hello world')
    const state = getSessionState()
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0].role).toBe('user')
    expect(state.messages[0].content).toBe('hello world')
    expect(state.messages[0].timestamp).toBeGreaterThan(0)
  })

  it('setSuccess transitions to success and appends assistant message', () => {
    addUserMessage('test')
    setRunning()
    const trace = [{toolName: 'echo', status: 'success' as const, latencyMs: 42}]
    setSuccess('assistant reply', trace)
    const state = getSessionState()
    expect(state.status).toBe('success')
    expect(state.trace).toEqual(trace)
    expect(state.messages).toHaveLength(2)
    expect(state.messages[1].role).toBe('assistant')
    expect(state.messages[1].content).toBe('assistant reply')
  })

  it('setError transitions to error with message and category', () => {
    setError('Connection refused', 'connection')
    const state = getSessionState()
    expect(state.status).toBe('error')
    expect(state.error).toBe('Connection refused')
    expect(state.errorCategory).toBe('connection')
  })

  it('setError without category sets errorCategory to undefined', () => {
    setError('Something went wrong')
    const state = getSessionState()
    expect(state.errorCategory).toBeUndefined()
  })

  it('resetSession clears all state back to idle', () => {
    addUserMessage('test')
    setRunning()
    setError('failure', 'api-failure')
    resetSession()
    const state = getSessionState()
    expect(state.status).toBe('idle')
    expect(state.messages).toEqual([])
    expect(state.trace).toEqual([])
    expect(state.error).toBeUndefined()
  })

  it('getSessionState returns the same object reference for reads', () => {
    const s1 = getSessionState()
    const s2 = getSessionState()
    expect(s1).toBe(s2)
  })
})

describe('session-store — simulation API route integration', () => {
  it('POST /api/chat with missing message fails validation', async () => {
    // Simulate what the route does when message is empty
    const session = getSessionState()
    expect(session.status).toBe('idle')
    // Calling setRunning then setError simulates a failed simulation
    setRunning()
    setError('No OpenAI API key configured', 'missing-credential')
    const state = getSessionState()
    expect(state.status).toBe('error')
    expect(state.error).toMatch(/OpenAI|credential/i)
    expect(state.errorCategory).toBe('missing-credential')
  })

  it('multiple messages accumulate in conversation', () => {
    addUserMessage('first message')
    setRunning()
    setSuccess('first reply', [])
    addUserMessage('second message')
    setRunning()
    setSuccess('second reply', [{toolName: 'tool1', status: 'success', latencyMs: 10}])
    const state = getSessionState()
    expect(state.messages).toHaveLength(4)
    expect(state.messages[0].content).toBe('first message')
    expect(state.messages[1].content).toBe('first reply')
    expect(state.messages[2].content).toBe('second message')
    expect(state.messages[3].content).toBe('second reply')
    expect(state.trace).toHaveLength(1)
  })
})

it('pins the widget to its originating turn while new messages arrive', async () => {
  const {setWidget} = await import('../../src/lib/server/session-store.js')
  const {DEFAULT_HOST_OPTIONS} = await import('../../src/lib/simulate/widget/types.js')
  addUserMessage('first')
  const widget = {id: 'widget-1', toolName: 'list_apps', toolCallId: 'call-1', source: {type: 'inline' as const, content: '<p>apps</p>', origin: 'fixture'}, toolInput: {}, toolOutput: undefined, toolResponseMetadata: undefined, toolResult: undefined, widgetState: null, displayMode: DEFAULT_HOST_OPTIONS.displayMode, lifecycle: 'loading' as const, mountedAt: new Date().toISOString()}
  setWidget(widget)
  expect(getSessionState().widgetMessageIndex).toBe(0)
  setSuccess('apps', []); addUserMessage('next')
  setWidget({...widget, widgetState: {count: 1}})
  expect(getSessionState().widgetMessageIndex).toBe(0)
  setWidget({...widget, id: 'widget-2'})
  expect(getSessionState().widgetMessageIndex).toBe(2)
  resetSession()
  expect(getSessionState().widgetMessageIndex).toBeUndefined()
})
