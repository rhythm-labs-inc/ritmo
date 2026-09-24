/**
 * Contract rules that need the widget HTML or a live tool call (RHY-188).
 * Contract: docs/apps-sdk-contract.md §2–§4.
 *
 * Static (always run when templates exist):
 *   contract/widget-accessible-coverage  every tool the widget HTML calls is callable from the widget
 *   contract/template-uri-versioned      ui:// URIs carry a digest/version (host caches by URI)
 *
 * Runtime (only with `validate --probe-tools`, which calls zero-argument tools):
 *   contract/output-schema, contract/structured-content, contract/meta-leak  (see contract.ts)
 *   contract/read-only-probe             readOnlyHint tools return identical results on identical calls
 */

import {checkResultContract} from '../contract.js'
import {annotationsOf, templateRefOf, widgetAccessibleOf} from '../meta.js'
import type {Finding, Rule, ValidationContext} from '../types.js'

const hasTemplates = (ctx: ValidationContext) => ctx.templates.size > 0

/** Tool names referenced by `callTool("name"` / `callTool('name'` literals in a template. */
export function toolCallsInHtml(html: string): string[] {
  const out = new Set<string>()
  const re = /callTool\s*\(\s*["'`]([A-Za-z0-9_.-]+)["'`]/g
  for (const m of html.matchAll(re)) out.add(m[1])
  // raw postMessage form: method: 'tools/call', params: {name: 'x'}
  const raw = /["']tools\/call["'][^}]*?name\s*:\s*["']([A-Za-z0-9_.-]+)["']/g
  for (const m of html.matchAll(raw)) out.add(m[1])
  return [...out]
}

export const contractWidgetAccessible: Rule = {
  id: 'contract/widget-accessible-coverage',
  description: 'Every tool a widget template calls is marked callable from the widget (ui.visibility includes "app" / openai/widgetAccessible)',
  source: '§2',
  applies: hasTemplates,
  check(ctx) {
    const out: Finding[] = []
    const byName = new Map(ctx.tools.map((t) => [t.name, t]))
    const referenced = new Set<string>()
    for (const t of ctx.templates.values()) {
      const html = t.content?.text
      if (!html) continue
      for (const name of toolCallsInHtml(html)) {
        referenced.add(name)
        const tool = byName.get(name)
        if (!tool) {
          out.push({
            rule: this.id, severity: 'warn', target: t.uri, source: this.source,
            message: `template calls "${name}" which the server does not expose`,
          })
          continue
        }
        if (widgetAccessibleOf(tool) !== true) {
          out.push({
            rule: this.id, severity: 'fail', target: name, source: this.source,
            message: `called from ${t.uri} but not marked widget-accessible`,
            hint: 'Set `_meta.ui.visibility: ["model","app"]` (and legacy `_meta["openai/widgetAccessible"]: true`) on the tool, or the host will refuse the widget\'s callTool.',
          })
        }
      }
    }
    for (const tool of ctx.tools) {
      if (widgetAccessibleOf(tool) === true && !referenced.has(tool.name) && ctx.templates.size > 0) {
        // Only meaningful if we could read at least one template's HTML
        const anyHtml = [...ctx.templates.values()].some((t) => t.content?.text)
        if (anyHtml) {
          out.push({
            rule: this.id, severity: 'info', target: tool.name, source: this.source,
            message: 'marked widget-accessible but no template calls it (stale flag, or called dynamically)',
          })
        }
      }
    }
    return out
  },
}

const VERSION_HINT = /[-_.](?:[0-9a-f]{6,}|v\d+)(?=\.[a-z0-9]+$|$)/i

export const contractTemplateUriVersioned: Rule = {
  id: 'contract/template-uri-versioned',
  description: 'ui:// template URIs expose a version hint for cache compatibility review',
  source: '§3',
  applies: hasTemplates,
  check(ctx) {
    const out: Finding[] = []
    for (const t of ctx.templates.values()) {
      if (t.referencedBy.length === 0) continue
      if (!VERSION_HINT.test(t.uri)) {
        out.push({
          rule: this.id, severity: 'warn', target: t.uri, source: this.source,
          message: 'URI has no digest/version segment',
          hint: 'Verify compatibility before changing content behind a published URI. Compatible content may keep its URI; breaking changes need a new resource contract, while old published resources remain usable. See docs/apps-sdk-contract.md §3.',
        })
      }
    }
    return out
  },
}

export const CONTRACT_STATIC_RULES: Rule[] = [contractWidgetAccessible, contractTemplateUriVersioned]

// ---------------------------------------------------------------------------
// Runtime rules (only when ctx.probeResults exists, i.e. --probe-tools)
// ---------------------------------------------------------------------------

const hasProbes = (ctx: ValidationContext) => ctx.probeResults !== undefined

export const contractProbeResults: Rule = {
  id: 'contract/probe-results',
  description: 'Runtime contract of probed tool results (output-schema, structured-content, meta-leak) — with --probe-tools',
  source: '§4',
  applies: hasProbes,
  check(ctx) {
    const out: Finding[] = []
    for (const p of ctx.probeResults!) {
      const tool = ctx.tools.find((t) => t.name === p.tool)
      if (p.error) {
        out.push({rule: this.id, severity: 'info', target: p.tool, source: this.source, message: `probe call with {} failed: ${p.error} (tool may need arguments; not a contract failure)`})
        continue
      }
      for (const r of p.results.slice(0, 1)) {
        out.push(...checkResultContract({name: p.tool, outputSchema: tool?.outputSchema}, r))
      }
    }
    return out
  },
}

export const contractReadOnlyProbe: Rule = {
  id: 'contract/read-only-probe',
  description: 'readOnlyHint tools return identical results on identical calls — with --probe-tools',
  source: '§2, §8',
  applies: hasProbes,
  check(ctx) {
    const out: Finding[] = []
    for (const p of ctx.probeResults!) {
      const tool = ctx.tools.find((t) => t.name === p.tool)
      if (!tool || annotationsOf(tool).readOnlyHint !== true || p.results.length < 2) continue
      const [a, b] = p.results
      const strip = (r: typeof a) => JSON.stringify({content: r.content, structuredContent: r.structuredContent ?? null, isError: r.isError ?? false})
      if (strip(a) !== strip(b)) {
        out.push({
          rule: this.id, severity: 'warn', target: p.tool, source: this.source,
          message: 'readOnlyHint: true but two identical calls returned different results',
          hint: 'A read-only tool must not change anything. If the call has side effects (counters, quotas, previews that count against a cap) set readOnlyHint: false and justify it. See docs/apps-sdk-contract.md §2.',
        })
      }
    }
    return out
  },
}

export const CONTRACT_RUNTIME_RULES: Rule[] = [contractProbeResults, contractReadOnlyProbe]

/** Static per-tool helper used by the read-only probe: does the tool accept `{}`? */
export function acceptsEmptyArgs(tool: {inputSchema?: unknown}): boolean {
  const s = tool.inputSchema as Record<string, unknown> | undefined
  if (!s || typeof s !== 'object') return true
  const req = s.required
  return !Array.isArray(req) || req.length === 0
}

/** Which tools have a widget template (used to decide what "probing" may render). */
export function hasTemplate(tool: Parameters<typeof templateRefOf>[0]): boolean {
  return templateRefOf(tool).uri !== undefined
}
