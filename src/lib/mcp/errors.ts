export type McpErrorCategory =
  | 'naming-conflict'
  | 'authentication'
  | 'cancelled'
  | 'connection'
  | 'handshake'
  | 'timeout'
  | 'args'
  | 'tool-not-found'
  | 'tool-call'
  | 'transport'

export class McpError extends Error {
  constructor(
    public readonly category: McpErrorCategory,
    message: string,
    public readonly hint?: string,
  ) {
    super(message)
    this.name = 'McpError'
  }
}

export function categorizeError(err: unknown, serverUrl: string): McpError {
  if (err instanceof McpError) return err

  const message = err instanceof Error ? err.message : String(err)
  const lower = message.toLowerCase()

  if (lower.includes('timeout') || lower.includes('timed out')) {
    return new McpError(
      'timeout',
      `Connection timed out connecting to ${serverUrl}`,
      'Check the server is running and the URL is reachable. Use --timeout to increase the limit.',
    )
  }

  if (
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('network') ||
    lower.includes('connect')
  ) {
    return new McpError(
      'connection',
      `Could not connect to MCP server at ${serverUrl}: ${message}`,
      'Check the server is running and the URL is correct.',
    )
  }

  if (lower.includes('handshake') || lower.includes('initialize') || lower.includes('protocol')) {
    return new McpError(
      'handshake',
      `MCP handshake failed with ${serverUrl}: ${message}`,
      'Ensure the server implements the MCP protocol correctly.',
    )
  }

  return new McpError(
    'connection',
    `Unexpected error connecting to ${serverUrl}: ${message}`,
    'Check the server is running and the URL is correct.',
  )
}
