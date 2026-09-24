import {describe, expect, it} from 'vitest'

import {formatAssistantResponse, formatTraceOutput} from '../../src/lib/simulate/output.js'
import type {TraceEvent} from '../../src/lib/simulate/trace.js'

describe('formatAssistantResponse', () => {
  it('wraps response in separators with Assistant label', () => {
    const output = formatAssistantResponse('Hello world!')
    expect(output).toContain('Assistant:')
    expect(output).toContain('Hello world!')
    expect(output).toContain('─')
  })

  it('handles multi-line response', () => {
    const output = formatAssistantResponse('Line 1\nLine 2\nLine 3')
    expect(output).toContain('Line 1')
    expect(output).toContain('Line 3')
  })

  it('handles empty response', () => {
    const output = formatAssistantResponse('')
    expect(output).toContain('Assistant:')
  })
})

describe('formatTraceOutput', () => {
  it('returns empty string for no events', () => {
    expect(formatTraceOutput([])).toBe('')
  })

  it('shows success icon and details for successful call', () => {
    const trace: TraceEvent[] = [
      {toolName: 'get_weather', status: 'success', latencyMs: 150},
    ]
    const output = formatTraceOutput(trace)
    expect(output).toContain('Tool call trace:')
    expect(output).toContain('✓')
    expect(output).toContain('get_weather')
    expect(output).toContain('success')
    expect(output).toContain('150ms')
  })

  it('shows error icon and message for failed call', () => {
    const trace: TraceEvent[] = [
      {toolName: 'send_email', status: 'error', latencyMs: 50, error: 'Auth failed'},
    ]
    const output = formatTraceOutput(trace)
    expect(output).toContain('✗')
    expect(output).toContain('send_email')
    expect(output).toContain('error')
    expect(output).toContain('Auth failed')
  })

  it('handles multiple trace events', () => {
    const trace: TraceEvent[] = [
      {toolName: 'tool_a', status: 'success', latencyMs: 100},
      {toolName: 'tool_b', status: 'error', latencyMs: 200, error: 'timeout'},
    ]
    const output = formatTraceOutput(trace)
    expect(output).toContain('tool_a')
    expect(output).toContain('tool_b')
    expect(output).toContain('timeout')
  })
})
