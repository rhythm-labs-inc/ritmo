import {terminalData, terminalStatus} from '../cli/ritmo-terminal.js'
import {redactSensitiveFields} from './redaction.js'

const PREVIEW_MAX_CHARS = 120

export interface InspectorCallOptions {
  toolName: string
  request: unknown
  response?: unknown
  error?: string
  latencyMs: number
  verbose: boolean
}

function preview(value: unknown, maxChars = PREVIEW_MAX_CHARS): string {
  const json = JSON.stringify(value)
  if (json.length <= maxChars) return json
  return json.slice(0, maxChars) + '…'
}

function timestamp(): string {
  return new Date().toISOString()
}

export function logCallResult(options: InspectorCallOptions): string[] {
  const {toolName, request, response, error, latencyMs, verbose} = options
  const ts = timestamp()
  const status = error ? 'error' : 'success'
  const lines: string[] = []

  if (verbose) {
    lines.push(`[${ts}] tool=${toolName} status=${status} latency=${latencyMs}ms`)
    lines.push('  request:  ' + terminalData(redactSensitiveFields(request)).replaceAll('\n', '\n  '))
    if (error) {
      lines.push('  error:    ' + error)
    } else {
      lines.push('  response: ' + terminalData(redactSensitiveFields(response)).replaceAll('\n', '\n  '))
    }
  } else {
    const redactedRequest = redactSensitiveFields(request)
    const reqPreview = preview(redactedRequest)

    if (error) {
      lines.push(
        `[${ts}] tool=${toolName} status=error latency=${latencyMs}ms`,
      )
      lines.push(`  req:   ${reqPreview}`)
      lines.push(`  error: ${error}`)
    } else {
      lines.push(
        `[${ts}] tool=${toolName} status=success latency=${latencyMs}ms`,
      )
      lines.push(`  req: ${reqPreview}`)
      const res = (response ?? {}) as Record<string, unknown>
      const isFullResult = typeof res === 'object' && res !== null && 'content' in res
      if (!isFullResult) {
        lines.push(`  res: ${preview(redactSensitiveFields(response))}`)
      } else {
        lines.push(`  content: ${preview(redactSensitiveFields(res.content))}`)
        if (res.structuredContent !== undefined) {
          lines.push(`  structuredContent: ${preview(redactSensitiveFields(res.structuredContent))}`)
        }
        if (res._meta !== undefined) {
          // widget-only; show keys + redacted preview so tokens never hit the terminal by accident
          lines.push(`  _meta (widget-only): ${preview(redactSensitiveFields(res._meta))}`)
        }
        if (res.isError) lines.push('  isError: true')
      }
    }
  }

  return lines.map((line) => line.startsWith('[') ? terminalStatus(error ? 'fail' : 'info', line) : line)
}
