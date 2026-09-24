/**
 * Tool-descriptor rules. Contract: docs/apps-sdk-contract.md §2 and §8.
 */

import {annotationsOf, isUiUri, securitySchemesOf, templateRefOf} from '../meta.js'
import type {Finding, Rule} from '../types.js'

const REQUIRED_ANNOTATIONS = ['readOnlyHint', 'destructiveHint', 'openWorldHint'] as const

const DESTRUCTIVE_NAME = /(^|[_.\-/])(delete|remove|destroy|revoke|purge|drop|wipe|cancel|unsubscribe)([_.\-/]|$)/i
const READ_NAME = /(^|[_.\-/])(get|list|search|fetch|read|lookup|find|show|describe|check|query)([_.\-/]|$)/i
const WRITE_NAME = /(^|[_.\-/])(create|update|save|set|add|send|post|publish|submit|write|start|connect|upload|delete|remove|edit|patch|put)([_.\-/]|$)/i

export const toolInputSchema: Rule = {
  id: 'tool/input-schema',
  description: 'Every tool declares an object inputSchema',
  source: '§2',
  check(ctx) {
    const out: Finding[] = []
    for (const t of ctx.tools) {
      const schema = t.inputSchema as Record<string, unknown> | undefined
      if (!schema || typeof schema !== 'object' || schema.type !== 'object') {
        out.push({
          rule: this.id, severity: 'fail', target: t.name, source: this.source,
          message: 'inputSchema is missing or not an object schema',
          hint: 'Declare `inputSchema: {type: "object", properties: {...}}` even for zero-argument tools.',
        })
      }
    }
    return out
  },
}

export const toolAnnotationsPresent: Rule = {
  hosts: ['chatgpt'], // OpenAI submission requirements, not portable MCP requirements; contract §2, §8.
  id: 'tool/annotations-present',
  description: 'readOnlyHint, destructiveHint and openWorldHint are set on every tool',
  source: '§2, §8',
  check(ctx) {
    const out: Finding[] = []
    for (const t of ctx.tools) {
      const a = annotationsOf(t)
      const missing = REQUIRED_ANNOTATIONS.filter((k) => typeof a[k] !== 'boolean')
      if (missing.length > 0) {
        out.push({
          rule: this.id, severity: 'fail', target: t.name, source: this.source,
          message: `missing annotation${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`,
          hint: 'The submission portal requires all three boolean hints on every tool, each with a written justification. See docs/apps-sdk-contract.md §8.',
        })
      }
    }
    return out
  },
}

export const toolAnnotationsHonest: Rule = {
  id: 'tool/annotations-honest',
  description: 'Annotations are consistent with each other and with the tool name',
  source: '§2, §8',
  check(ctx) {
    const out: Finding[] = []
    for (const t of ctx.tools) {
      const a = annotationsOf(t)
      const ro = a.readOnlyHint
      const de = a.destructiveHint
      const ow = a.openWorldHint
      if (ro === true && (de === true || ow === true)) {
        out.push({
          rule: this.id, severity: 'fail', target: t.name, source: this.source,
          message: `readOnlyHint: true contradicts ${de === true ? 'destructiveHint: true' : 'openWorldHint: true'}`,
          hint: 'A read-only tool changes nothing, so it cannot be destructive or change public state. Pick one.',
        })
      }
      if (DESTRUCTIVE_NAME.test(t.name) && de === false) {
        out.push({
          rule: this.id, severity: 'warn', target: t.name, source: this.source,
          message: 'name suggests a destructive action but destructiveHint is false',
          hint: 'Reviewers reject annotations that don\'t match behaviour. Set destructiveHint: true or rename the tool.',
        })
      }
      if (DESTRUCTIVE_NAME.test(t.name) && ro === true) {
        out.push({
          rule: this.id, severity: 'warn', target: t.name, source: this.source,
          message: 'name suggests a destructive action but readOnlyHint is true',
        })
      }
      if (READ_NAME.test(t.name) && !WRITE_NAME.test(t.name) && ro === false) {
        out.push({
          rule: this.id, severity: 'info', target: t.name, source: this.source,
          message: 'name looks read-only but readOnlyHint is false — fine if the call has side effects (e.g. counts against a quota); be ready to justify it',
        })
      }
    }
    return out
  },
}

export const toolSecuritySchemes: Rule = {
  hosts: ['chatgpt'], // OpenAI submission requirements, not portable MCP requirements; contract §2, §8.
  id: 'tool/security-schemes',
  description: 'securitySchemes declared (top level, mirrored in _meta)',
  source: '§2',
  check(ctx) {
    const out: Finding[] = []
    for (const t of ctx.tools) {
      const {top, meta} = securitySchemesOf(t)
      if (top === undefined && meta === undefined) {
        out.push({
          rule: this.id, severity: 'warn', target: t.name, source: this.source,
          message: 'no securitySchemes declared',
          hint: 'Declare `securitySchemes: [{type: "noauth"}]` (or an oauth2 scheme) on the tool and mirror it in `_meta.securitySchemes` for older clients.',
        })
      } else if (top === undefined && meta !== undefined) {
        out.push({
          rule: this.id, severity: 'info', target: t.name, source: this.source,
          message: 'securitySchemes only present under _meta (back-compat mirror); add it at the top level too',
        })
      }
    }
    return out
  },
}

export const toolOutputSchema: Rule = {
  id: 'tool/output-schema',
  description: 'Validate outputSchema when present; ChatGPT submission warns when absent',
  source: '§2, §8',
  check(ctx) {
    const out: Finding[] = []
    for (const t of ctx.tools) {
      const schema = t.outputSchema as Record<string, unknown> | undefined
      if (!schema || typeof schema !== 'object') {
        // Absence is a ChatGPT portal warning, not a portable MCP requirement (contract §2, §8).
        if (schema === undefined && ctx.host === 'mcp-apps') continue
        out.push({
          rule: this.id, severity: 'warn', target: t.name, source: this.source,
          message: 'no outputSchema',
          hint: 'Declare an outputSchema for any tool that returns structuredContent; the submission portal shows a per-tool warning without it.',
        })
      } else if (schema.type !== 'object') {
        out.push({
          rule: this.id, severity: 'fail', target: t.name, source: this.source,
          message: `outputSchema.type must be "object" (got ${JSON.stringify(schema.type)})`,
        })
      }
    }
    return out
  },
}

export const toolNaming: Rule = {
  id: 'tool/name',
  description: 'Tool names are unique, ≤ 64 chars, and use [a-z0-9_.-]',
  source: '§2, §9',
  check(ctx) {
    const out: Finding[] = []
    const seen = new Map<string, number>()
    for (const t of ctx.tools) seen.set(t.name, (seen.get(t.name) ?? 0) + 1)
    for (const [name, n] of seen) {
      if (n > 1) {
        out.push({rule: this.id, severity: 'fail', target: name, source: this.source, message: `tool name appears ${n} times`})
      }
    }
    for (const t of ctx.tools) {
      if (t.name.length === 0) {
        out.push({rule: this.id, severity: 'fail', target: '(empty)', source: this.source, message: 'empty tool name'})
        continue
      }
      if (t.name.length > 64) {
        out.push({rule: this.id, severity: 'warn', target: t.name, source: this.source, message: `name is ${t.name.length} chars (> 64)`, hint: 'Keep names short; some hosts cap tool names at 64 characters.'})
      }
      if (!/^[a-zA-Z0-9_.-]+$/.test(t.name)) {
        out.push({rule: this.id, severity: 'warn', target: t.name, source: this.source, message: 'name contains characters outside [A-Za-z0-9_.-]', hint: 'Use snake_case or dotted domain.action names.'})
      }
    }
    return out
  },
}

export const toolTitle: Rule = {
  id: 'tool/title',
  description: 'Tools carry a human-readable title',
  source: '§2, §9',
  check(ctx) {
    const out: Finding[] = []
    for (const t of ctx.tools) {
      const title = t.title ?? annotationsOf(t).title
      if (typeof title !== 'string' || title.trim().length === 0) {
        out.push({
          rule: this.id, severity: 'warn', target: t.name, source: this.source,
          message: 'no title',
          hint: 'Set `title` on the tool. Required for the Claude connectors directory; recommended by the Apps SDK docs.',
        })
      }
    }
    return out
  },
}

export const toolDescription: Rule = {
  id: 'tool/description',
  description: 'Descriptions exist, are substantive, and say when to use the tool',
  source: '§2, §8',
  check(ctx) {
    const out: Finding[] = []
    for (const t of ctx.tools) {
      const d = typeof t.description === 'string' ? t.description.trim() : ''
      if (d.length === 0) {
        out.push({
          rule: this.id, severity: 'fail', target: t.name, source: this.source,
          message: 'no description',
          hint: 'Describe what the tool does and when the model should use it; reviewers reject tools whose descriptions don\'t match behaviour.',
        })
        continue
      }
      if (d.length < 20) {
        out.push({rule: this.id, severity: 'warn', target: t.name, source: this.source, message: `description is very short (${d.length} chars)`})
      }
      if (!/\b(?:(?:use|call|invoke)(?:\s+(?:this|it|the))?(?:\s+tool)?(?:\s+only)?\s+(?:when|if|after|before|to|for)|when\s+(?:the\s+)?user)\b/i.test(d)) {
        out.push({
          rule: this.id, severity: 'info', target: t.name, source: this.source,
          message: 'usage-guidance heuristic found no familiar trigger phrase; review the description in context',
          hint: 'Describe when to use the tool and any exclusions. Wording such as "Use this after…" is fine; no exact phrase is required. This heuristic cannot determine semantic completeness.',
        })
      }
    }
    return out
  },
}

export const toolTemplateRef: Rule = {
  id: 'tool/widget-template-ref',
  description: 'Widget references use _meta.ui.resourceUri (+ openai/outputTemplate alias) with a ui:// URI that resolves',
  source: '§2, §3',
  check(ctx) {
    const out: Finding[] = []
    for (const t of ctx.tools) {
      const {uri, standard, alias} = templateRefOf(t)
      if (!uri) continue
      if (standard && alias && standard !== alias) {
        out.push({
          rule: this.id, severity: 'fail', target: t.name, source: this.source,
          message: `_meta.ui.resourceUri (${standard}) and _meta["openai/outputTemplate"] (${alias}) disagree`,
          hint: 'Set both keys to the same ui:// URI.',
        })
      }
      if (!standard && alias) {
        out.push({
          rule: this.id, severity: 'warn', target: t.name, source: this.source,
          message: 'only the legacy alias _meta["openai/outputTemplate"] is set; add _meta.ui.resourceUri',
          hint: 'The standard MCP Apps key is `_meta.ui.resourceUri`; keep the alias for compatibility.',
        })
      }
      if (standard && !alias) {
        out.push({
          rule: this.id, severity: 'info', target: t.name, source: this.source,
          message: 'add _meta["openai/outputTemplate"] alongside ui.resourceUri for older ChatGPT clients',
        })
      }
      if (!isUiUri(uri)) {
        const looksLikeHtml = /^\s*</.test(uri)
        out.push({
          rule: this.id, severity: 'fail', target: t.name, source: this.source,
          message: looksLikeHtml
            ? 'widget template is inline HTML; the host expects a ui:// resource URI'
            : `widget template reference is not a ui:// URI (${uri.slice(0, 60)})`,
          hint: 'Register the HTML as an MCP resource with a `ui://` URI and mimeType `text/html;profile=mcp-app`, then reference that URI.',
        })
        continue
      }
      const tmpl = ctx.templates.get(uri)
      if (!tmpl || (!tmpl.content && tmpl.readError)) {
        out.push({
          rule: this.id, severity: 'fail', target: t.name, source: this.source,
          message: `template ${uri} could not be read: ${tmpl?.readError ?? 'unknown error'}`,
          hint: 'The host fetches templates via resources/read at render time. Make sure the server advertises the resources capability and serves this URI.',
        })
      } else if (!tmpl.listed) {
        out.push({
          rule: this.id, severity: 'info', target: t.name, source: this.source,
          message: `template ${uri} is readable but not in resources/list`,
          hint: 'Listing it helps tooling discover templates; not required by the host.',
        })
      }
    }
    return out
  },
}

export const TOOL_RULES: Rule[] = [
  toolInputSchema,
  toolNaming,
  toolTitle,
  toolDescription,
  toolAnnotationsPresent,
  toolAnnotationsHonest,
  toolSecuritySchemes,
  toolOutputSchema,
  toolTemplateRef,
]
