/**
 * Widget source resolver.
 *
 * The current Apps SDK contract (docs/apps-sdk-contract.md §2–§3): the tool
 * DESCRIPTOR carries a `ui://` URI in `_meta.ui.resourceUri` (alias
 * `_meta["openai/outputTemplate"]`) and the host fetches the HTML via
 * `resources/read` — see `templateUriForTool()` + `TemplateCache`.
 *
 * Legacy fallbacks, resolved from the tool RESULT via `resolveWidgetSource()`:
 *   - **inline** — HTML embedded in `_meta.openai/outputTemplate` (pre-2026 convention)
 *   - **local**  — a localhost/https URL in `_meta.widgetUrl` / `widgetUrl`
 */

import type {RawResourceContent, RawTool} from '../../mcp/client.js'
import {isAllowedWidgetUrl, validateInlineContent} from './security.js'
import type {WidgetSource} from './types.js'

// ---------------------------------------------------------------------------
// ui:// templates (current contract)
// ---------------------------------------------------------------------------

/** The ui:// template URI a tool descriptor advertises, if any. */
export function templateUriForTool(tool: RawTool | {_meta?: unknown} | undefined): string | undefined {
  const meta = (tool?._meta ?? {}) as Record<string, unknown>
  const ui = (meta.ui ?? {}) as Record<string, unknown>
  const standard = typeof ui.resourceUri === 'string' ? ui.resourceUri : undefined
  const alias = typeof meta['openai/outputTemplate'] === 'string' ? (meta['openai/outputTemplate'] as string) : undefined
  const uri = standard ?? alias
  return uri && uri.startsWith('ui://') ? uri : undefined
}

export type TemplateReader = (uri: string) => Promise<RawResourceContent[]>

/**
 * Local per-connection cache, reset on reconnect. This approximates the host;
 * it does not implement ChatGPT's bounded freshness (contract §3).
 */
export class TemplateCache {
  private readonly entries = new Map<string, Promise<WidgetSource>>()

  constructor(private readonly read: TemplateReader) {}

  get(uri: string): Promise<WidgetSource> {
    let p = this.entries.get(uri)
    if (!p) {
      p = this.fetch(uri)
      this.entries.set(uri, p)
      // Don't cache failures — a server restart or late registration should be retryable.
      p.catch(() => this.entries.delete(uri))
    }
    return p
  }

  has(uri: string): boolean {
    return this.entries.has(uri)
  }

  clear(): void {
    this.entries.clear()
  }

  private async fetch(uri: string): Promise<WidgetSource> {
    const contents = await this.read(uri)
    const first = contents[0]
    if (!first) {
      throw new WidgetLoadError(`resources/read for ${uri} returned no contents`, 'Return {uri, mimeType, text} from resources/read.')
    }
    if (typeof first.text !== 'string' || first.text.trim().length === 0) {
      throw new WidgetLoadError(
        `Template ${uri} has no text content`,
        first.blob ? 'The template was returned as a blob; the host expects text/html.' : 'Return the HTML in the `text` field.',
      )
    }
    return {type: 'template', content: first.text, origin: uri, mimeType: first.mimeType}
  }
}

/** Convenience: preload every template referenced by a tool list. Failures are returned, not thrown. */
export async function preloadTemplates(tools: RawTool[], cache: TemplateCache): Promise<Map<string, string | undefined>> {
  const outcome = new Map<string, string | undefined>()
  for (const tool of tools) {
    const uri = templateUriForTool(tool)
    if (!uri || outcome.has(uri)) continue
    try {
      await cache.get(uri)
      outcome.set(uri, undefined)
    } catch (err) {
      outcome.set(uri, err instanceof Error ? err.message : String(err))
    }
  }
  return outcome
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * LEGACY: resolve a widget source from a tool RESULT payload.
 *
 * Looks for widget content in the following locations (in order):
 *   1. `_meta.openai/outputTemplate` — inline HTML (pre-2026 convention). A `ui://`
 *      value here is NOT inline HTML; it is ignored by this function (use templateUriForTool).
 *   2. `_meta.widgetUrl` — local widget URL
 *   3. `widgetUrl` — top-level widget URL field
 *   4. `_meta.openai/widgetUrl` — alternative location
 *
 * Returns `null` if no widget source is found.
 * Throws `WidgetLoadError` if a source is found but invalid.
 */
export function resolveWidgetSource(toolOutput: unknown): WidgetSource | null {
  if (!toolOutput || typeof toolOutput !== 'object') return null

  const output = toolOutput as Record<string, unknown>
  const meta = (output._meta ?? output.meta ?? {}) as Record<string, unknown>

  // 1. Inline template from _meta.openai/outputTemplate (legacy). ui:// URIs belong to the descriptor path.
  const inlineTemplate = meta['openai/outputTemplate'] as string | undefined
  if (typeof inlineTemplate === 'string' && inlineTemplate.trim().length > 0 && !inlineTemplate.trim().startsWith('ui://')) {
    return resolveInlineSource(inlineTemplate)
  }

  // 2. Widget URL from various locations
  const urlCandidates = [
    meta.widgetUrl,
    meta['openai/widgetUrl'],
    output.widgetUrl,
  ]

  for (const candidate of urlCandidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return resolveLocalSource(candidate.trim())
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Internal resolvers
// ---------------------------------------------------------------------------

function resolveLocalSource(url: string): WidgetSource {
  if (!isAllowedWidgetUrl(url)) {
    throw new WidgetLoadError(
      `Widget URL is not allowed: ${url}`,
      'Only localhost, 127.0.0.1, and HTTPS URLs are permitted for widget sources.',
    )
  }

  return {
    type: 'local',
    content: url,
    origin: url,
  }
}

function resolveInlineSource(html: string): WidgetSource {
  const trimmed = html.trim()

  if (trimmed.length === 0) {
    throw new WidgetLoadError(
      'Inline widget template is empty.',
      'The _meta.openai/outputTemplate field must contain non-empty HTML content.',
    )
  }

  const {warnings} = validateInlineContent(trimmed)
  if (warnings.length > 0) {
    // Log warnings but still allow — sandbox is the real boundary
    // These are advisory, not blocking
  }

  return {
    type: 'inline',
    content: trimmed,
    origin: '_meta.openai/outputTemplate',
  }
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class WidgetLoadError extends Error {
  readonly hint?: string

  constructor(message: string, hint?: string) {
    super(message)
    this.name = 'WidgetLoadError'
    this.hint = hint
  }
}
