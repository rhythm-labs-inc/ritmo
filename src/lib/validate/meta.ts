/**
 * Helpers for reading Apps SDK / MCP Apps metadata off raw descriptors.
 * Key names and their meaning: docs/apps-sdk-contract.md §2–§3.
 */

import type {RawResource, RawResourceContent, RawTool} from '../mcp/client.js'

export const WIDGET_MIME_TYPE = 'text/html;profile=mcp-app'
export const LEGACY_WIDGET_MIME_TYPES = ['text/html+skybridge']

export function metaOf(obj: RawTool | RawResource | RawResourceContent | undefined): Record<string, unknown> {
  const meta = obj?._meta
  return meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : {}
}

/** `_meta.ui` sub-object (standard MCP Apps namespace). */
export function uiMetaOf(obj: RawTool | RawResource | RawResourceContent | undefined): Record<string, unknown> {
  const ui = metaOf(obj).ui
  return ui && typeof ui === 'object' ? (ui as Record<string, unknown>) : {}
}

/**
 * Metadata for a widget resource can appear on its resources/list descriptor,
 * its resources/read content, or both. Keep the listing as the baseline: a
 * resource read is often only `{uri, mimeType, text}`. If it does provide
 * metadata, it is the more specific response and wins field by field.
 *
 * See docs/apps-sdk-contract.md §3.
 */
export function resourceMetadataSource(listed: RawResource | undefined, content: RawResourceContent | undefined): RawResource | undefined {
  if (!listed && !content) return undefined

  const listedMeta = metaOf(listed)
  const contentMeta = metaOf(content)
  const listedUi = uiMetaOf(listed)
  const contentUi = uiMetaOf(content)
  const hasUi = Object.keys(listedUi).length > 0 || Object.keys(contentUi).length > 0

  return {
    uri: content?.uri ?? listed?.uri ?? '',
    _meta: {
      ...listedMeta,
      ...contentMeta,
      ...(hasUi ? {ui: {...listedUi, ...contentUi}} : {}),
    },
  }
}

/**
 * The widget template URI a tool descriptor references, if any, plus which
 * keys carried it. Standard key: `_meta.ui.resourceUri`; alias: `_meta["openai/outputTemplate"]`.
 */
export function templateRefOf(tool: RawTool): {
  uri: string | undefined
  standard: string | undefined
  alias: string | undefined
} {
  const standard = asString(uiMetaOf(tool).resourceUri)
  const alias = asString(metaOf(tool)['openai/outputTemplate'])
  return {uri: standard ?? alias, standard, alias}
}

export function isUiUri(value: string | undefined): boolean {
  return typeof value === 'string' && value.startsWith('ui://')
}

/** `annotations` object of a tool, or `{}`. */
export function annotationsOf(tool: RawTool): Record<string, unknown> {
  const a = tool.annotations
  return a && typeof a === 'object' ? (a as Record<string, unknown>) : {}
}

/** `securitySchemes` from the top level or the `_meta` mirror. */
export function securitySchemesOf(tool: RawTool): {top: unknown; meta: unknown} {
  return {top: tool.securitySchemes, meta: metaOf(tool).securitySchemes}
}

/** Whether the widget may call this tool (`ui.visibility` includes "app" or legacy widgetAccessible). */
export function widgetAccessibleOf(tool: RawTool): boolean | undefined {
  const vis = uiMetaOf(tool).visibility
  if (Array.isArray(vis)) return vis.includes('app')
  const legacy = metaOf(tool)['openai/widgetAccessible']
  if (typeof legacy === 'boolean') return legacy
  return undefined
}

/** CSP declaration on a resource: standard `ui.csp` or legacy `openai/widgetCSP`. */
export function cspOf(res: RawResource | RawResourceContent | undefined): {
  standard: Record<string, unknown> | undefined
  legacy: Record<string, unknown> | undefined
} {
  const standard = uiMetaOf(res).csp
  const legacy = metaOf(res)['openai/widgetCSP']
  return {
    standard: standard && typeof standard === 'object' ? (standard as Record<string, unknown>) : undefined,
    legacy: legacy && typeof legacy === 'object' ? (legacy as Record<string, unknown>) : undefined,
  }
}

/** Domain declaration on a resource: standard `ui.domain` or legacy `openai/widgetDomain`. */
export function domainOf(res: RawResource | RawResourceContent | undefined): {
  standard: string | undefined
  legacy: string | undefined
} {
  return {
    standard: asString(uiMetaOf(res).domain),
    legacy: asString(metaOf(res)['openai/widgetDomain']),
  }
}

/** All domains a CSP object allows (standard camelCase or legacy snake_case fields). */
export function cspDomains(csp: Record<string, unknown> | undefined): string[] {
  if (!csp) return []
  const keys = ['connectDomains', 'resourceDomains', 'frameDomains', 'connect_domains', 'resource_domains', 'frame_domains', 'redirect_domains', 'redirectDomains']
  const out: string[] = []
  for (const k of keys) {
    const v = csp[k]
    if (Array.isArray(v)) out.push(...v.filter((x): x is string => typeof x === 'string'))
  }
  return out
}

/**
 * External hosts referenced by a widget HTML template: `<script src>`, `<link href>`,
 * `<img src>`, `<iframe src>`, `fetch("http…")`, and bare `https://host` literals.
 * Returns hostnames (deduped). Best-effort regex, not an HTML parser.
 */
export function externalHostsInHtml(html: string): {scripts: string[]; hosts: string[]} {
  const scripts = new Set<string>()
  const hosts = new Set<string>()
  const scriptSrc = /<script[^>]*\ssrc\s*=\s*["']([^"']+)["']/gi
  for (const m of html.matchAll(scriptSrc)) {
    const host = hostOf(m[1])
    if (host) {
      scripts.add(host)
      hosts.add(host)
    }
  }
  const anyUrl = /https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?/gi
  for (const m of html.matchAll(anyUrl)) {
    hosts.add(m[1].toLowerCase())
  }
  return {scripts: [...scripts], hosts: [...hosts]}
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}
