/**
 * Widget-template (resource) rules. Contract: docs/apps-sdk-contract.md §3 and §8.
 * Each rule iterates `ctx.templates` (every ui:// URI referenced by a tool or listed).
 */

import {
  LEGACY_WIDGET_MIME_TYPES,
  WIDGET_MIME_TYPE,
  cspDomains,
  cspOf,
  domainOf,
  externalHostsInHtml,
  metaOf,
  resourceMetadataSource,
} from '../meta.js'
import type {Finding, Rule, ValidationContext, WidgetTemplate} from '../types.js'

const hasTemplates = (ctx: ValidationContext) => ctx.templates.size > 0

/** Resource reads can omit metadata that resources/list correctly supplied. */
function metaSource(t: WidgetTemplate) {
  return resourceMetadataSource(t.listed, t.content)
}

function mimeOf(t: WidgetTemplate): string | undefined {
  const fromRead = t.content?.mimeType
  const fromList = typeof t.listed?.mimeType === 'string' ? (t.listed.mimeType as string) : undefined
  return fromRead ?? fromList
}

export const widgetMimeType: Rule = {
  id: 'widget/mime-type',
  description: `Widget templates are served as ${WIDGET_MIME_TYPE}`,
  source: '§3',
  applies: hasTemplates,
  check(ctx) {
    const out: Finding[] = []
    for (const t of ctx.templates.values()) {
      if (!t.content && !t.listed) continue
      const mime = mimeOf(t)
      if (mime === WIDGET_MIME_TYPE) continue
      if (mime && LEGACY_WIDGET_MIME_TYPES.includes(mime)) {
        out.push({
          rule: this.id, severity: 'warn', target: t.uri, source: this.source,
          message: `legacy mimeType ${mime}`,
          hint: `Serve the template as ${WIDGET_MIME_TYPE} (MCP Apps standard).`,
        })
      } else {
        out.push({
          rule: this.id, severity: 'fail', target: t.uri, source: this.source,
          message: `mimeType is ${mime ?? 'missing'}; expected ${WIDGET_MIME_TYPE}`,
          hint: 'The host only renders resources with the mcp-app HTML profile.',
        })
      }
    }
    return out
  },
}

export const widgetHasHtml: Rule = {
  id: 'widget/has-html',
  description: 'resources/read returns non-empty HTML text for each template',
  source: '§3',
  applies: hasTemplates,
  check(ctx) {
    const out: Finding[] = []
    for (const t of ctx.templates.values()) {
      if (t.readError) {
        out.push({
          rule: this.id, severity: 'fail', target: t.uri, source: this.source,
          message: `resources/read failed: ${t.readError}`,
        })
        continue
      }
      const text = t.content?.text
      if (typeof text !== 'string' || text.trim().length === 0) {
        out.push({
          rule: this.id, severity: 'fail', target: t.uri, source: this.source,
          message: t.content?.blob ? 'template returned as blob, expected text' : 'template has no text content',
          hint: 'Return `{uri, mimeType, text: "<html>…"}` from resources/read.',
        })
      } else if (!/<(html|body|div|script|main|section|template)\b/i.test(text)) {
        out.push({rule: this.id, severity: 'warn', target: t.uri, source: this.source, message: 'template text does not look like HTML'})
      }
    }
    return out
  },
}

export const widgetDomain: Rule = {
  id: 'widget/domain',
  description: 'Templates declare _meta.ui.domain (standard key; required for submission)',
  source: '§3, §8',
  applies: hasTemplates,
  check(ctx) {
    const out: Finding[] = []
    for (const t of ctx.templates.values()) {
      const src = metaSource(t)
      if (!src) continue
      const {standard, legacy} = domainOf(src)
      if (standard) continue
      if (legacy) {
        out.push({
          rule: this.id, severity: 'fail', target: t.uri, source: this.source,
          message: 'only legacy _meta["openai/widgetDomain"] is set; the portal checker reads _meta.ui.domain',
          hint: 'Add `_meta.ui.domain` with the same origin. Observed: the portal ignores the legacy alias (docs/apps-sdk-contract.md §3).',
        })
      } else {
        out.push({
          rule: this.id, severity: 'fail', target: t.uri, source: this.source,
          message: 'no _meta.ui.domain on the widget resource',
          hint: 'Set `_meta.ui.domain` to the origin the widget is served from; required for submission.',
        })
      }
    }
    return out
  },
}

export const widgetCsp: Rule = {
  id: 'widget/csp',
  description: 'Templates declare _meta.ui.csp covering every external host the HTML touches',
  source: '§3, §8',
  applies: hasTemplates,
  check(ctx) {
    const out: Finding[] = []
    for (const t of ctx.templates.values()) {
      const src = metaSource(t)
      if (!src) continue
      const {standard, legacy} = cspOf(src)
      const html = t.content?.text ?? ''
      const {hosts, scripts} = externalHostsInHtml(html)

      if (!standard && legacy) {
        out.push({
          rule: this.id, severity: 'fail', target: t.uri, source: this.source,
          message: 'only legacy _meta["openai/widgetCSP"] is set; the portal checker reads _meta.ui.csp',
          hint: 'Declare `_meta.ui.csp = {connectDomains: [...], resourceDomains: [...]}` (camelCase, standard keys). Keep the legacy alias if you need redirect_domains.',
        })
      } else if (!standard && !legacy) {
        out.push({
          rule: this.id, severity: hosts.length > 0 ? 'fail' : 'warn', target: t.uri, source: this.source,
          message: hosts.length > 0
            ? `no CSP declared but the template references external hosts: ${hosts.join(', ')}`
            : 'no _meta.ui.csp declared',
          hint: 'Declare `_meta.ui.csp` even if empty (`{connectDomains: [], resourceDomains: []}`); the portal requires the CSP to match exactly the domains the UI fetches.',
        })
      }

      const allowed = new Set([...cspDomains(standard), ...cspDomains(legacy)].map((d) => d.toLowerCase().replace(/^https?:\/\//, '')))
      const domain = domainOf(src).standard ?? domainOf(src).legacy
      const own = domain ? domain.toLowerCase().replace(/^https?:\/\//, '') : undefined
      const uncovered = hosts.filter((h) => h !== own && ![...allowed].some((a) => h === a || h.endsWith('.' + a.replace(/^\*\./, ''))))
      if ((standard || legacy) && uncovered.length > 0) {
        out.push({
          rule: this.id, severity: 'warn', target: t.uri, source: this.source,
          message: `template references hosts not covered by its CSP: ${uncovered.join(', ')}`,
          hint: 'Add them to connectDomains/resourceDomains, or remove the references. Mismatched CSP is a rejection trigger.',
        })
      }
      if (scripts.length > 0) {
        out.push({
          rule: this.id, severity: 'warn', target: t.uri, source: this.source,
          message: `external <script src> from ${scripts.join(', ')} — bundle it inline if you can`,
          hint: 'Common rejection: missing bundles. Self-contained templates are the safest.',
        })
      }
    }
    return out
  },
}

export const widgetDescription: Rule = {
  id: 'widget/description',
  description: 'Templates carry _meta["openai/widgetDescription"] (surfaced to the model when the component loads)',
  source: '§3',
  applies: hasTemplates,
  check(ctx) {
    const out: Finding[] = []
    for (const t of ctx.templates.values()) {
      const src = metaSource(t)
      if (!src) continue
      const d = metaOf(src)['openai/widgetDescription']
      if (typeof d !== 'string' || d.trim().length === 0) {
        out.push({
          rule: this.id, severity: 'info', target: t.uri, source: this.source,
          message: 'no openai/widgetDescription',
          hint: 'A one-line summary the model sees when the widget renders; helps it narrate correctly.',
        })
      }
    }
    return out
  },
}

export const widgetOrphaned: Rule = {
  id: 'widget/orphaned',
  description: 'Every listed ui:// resource is referenced by at least one tool',
  source: '§3',
  applies: hasTemplates,
  check(ctx) {
    const out: Finding[] = []
    for (const t of ctx.templates.values()) {
      if (t.referencedBy.length === 0 && t.listed) {
        out.push({
          rule: this.id, severity: 'info', target: t.uri, source: this.source,
          message: 'ui:// resource is listed but no tool references it',
        })
      }
    }
    return out
  },
}

export const WIDGET_RULES: Rule[] = [
  widgetHasHtml,
  widgetMimeType,
  widgetDomain,
  widgetCsp,
  widgetDescription,
  widgetOrphaned,
]
