import {terminalDivider, terminalProse, terminalStatus} from '../cli/ritmo-terminal.js'
import type {TraceEvent} from './trace.js'

export function formatAssistantResponse(content: string): string {
  const separator = terminalDivider()
  return `\n${separator}\nAssistant:\n${separator}\n${content}\n${separator}`
}

export function formatTraceOutput(trace: TraceEvent[]): string {
  if (trace.length === 0) return ''

  const lines: string[] = ['', 'Tool call trace:']
  for (const event of trace) {
    const statusIcon = event.status === 'success' ? '✓' : '✗'
    let line = `  ${statusIcon} ${event.toolName}  ${event.status}  ${event.latencyMs}ms`
    if (event.error) {
      line += `  — ${event.error}`
    }

    lines.push(terminalProse(terminalStatus(event.status === 'success' ? 'pass' : 'fail', line)))
    if (event.status !== 'success') lines.push(terminalProse(`    Location: ${event.toolName} (source file/line unavailable)\n    Expected: the tool call completes successfully.\n    Received: ${event.error ?? event.status}\n    Impact: this call did not establish a successful tool result.`))
  }

  return lines.join('\n')
}
