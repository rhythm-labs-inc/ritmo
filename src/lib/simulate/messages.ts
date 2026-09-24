import type {ToolCallResult} from '../mcp/client.js'

/**
 * Serialize MCP `content[]` (text / image / audio / resource / resource_link)
 * into a plain string for the model. Non-text parts are summarised, not
 * JSON-dumped — a base64 image is noise to a text model.
 */
export function serializeMcpContent(content: unknown): string {
  if (typeof content === 'string') return content

  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const item of content) {
      parts.push(serializePart(item))
    }

    return parts.join('\n')
  }

  if (content === undefined || content === null) return ''
  return JSON.stringify(content)
}

function serializePart(item: unknown): string {
  if (typeof item !== 'object' || item === null) return String(item)
  const part = item as Record<string, unknown>
  const type = typeof part.type === 'string' ? part.type : undefined

  if (type === 'text' || (type === undefined && 'text' in part)) {
    return String(part.text ?? '')
  }

  if (type === 'image' || type === 'audio') {
    const mime = typeof part.mimeType === 'string' ? part.mimeType : 'unknown type'
    const data = typeof part.data === 'string' ? part.data : ''
    const bytes = Math.floor((data.length * 3) / 4)
    return `[${type}: ${mime}, ~${bytes} bytes]`
  }

  if (type === 'resource') {
    const res = (part.resource ?? {}) as Record<string, unknown>
    if (typeof res.text === 'string') return res.text
    return `[resource: ${String(res.uri ?? 'unknown')}${res.mimeType ? `, ${String(res.mimeType)}` : ''}]`
  }

  if (type === 'resource_link') {
    return `[resource link: ${String(part.uri ?? part.name ?? 'unknown')}]`
  }

  return JSON.stringify(part)
}

/**
 * Build the string the *model* sees for a tool result — the model-visible half
 * of the Apps SDK contract (docs/apps-sdk-contract.md §4):
 *
 *   - `content[]` narration (text), then
 *   - `structuredContent` as JSON,
 *   - never `_meta` (widget-only; may hold session tokens).
 */
export function formatToolResultForModel(result: Pick<ToolCallResult, 'content' | 'structuredContent' | 'isError'>): string {
  const narration = serializeMcpContent(result.content).trim()
  const structured = result.structuredContent !== undefined
    ? JSON.stringify(result.structuredContent)
    : ''

  if (narration && structured) {
    // Avoid duplicating when the server put the same JSON in content and structuredContent.
    if (narration === structured) return structured
    return `${narration}\n\n${structured}`
  }

  if (structured) return structured
  if (narration) return narration
  return result.isError ? 'Error: tool returned no content' : ''
}
