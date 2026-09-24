/**
 * Claude connectors directory / MCP Apps host rules (host profile `mcp-apps`).
 * Sources: docs/apps-sdk-contract.md §9 — Anthropic's pre-submission checklist
 * (https://claude.com/docs/connectors/building/review-criteria, read 2026-08-17)
 * and the MCP Apps extension spec (method names, _meta.ui.* keys).
 *
 * A few of these are useful on ChatGPT too (catch-all tools, prompt-injection
 * patterns) and run there at a softer severity.
 */

import {annotationsOf, cspOf, domainOf, resourceMetadataSource, templateRefOf} from '../meta.js'
import type {Finding, HostProfile, Rule, ValidationContext} from '../types.js'

const isMcpApps = (ctx: ValidationContext) => (ctx.host ?? 'chatgpt') === 'mcp-apps'
const sev = (ctx: ValidationContext, mcpApps: Finding['severity'], chatgpt: Finding['severity']) => (isMcpApps(ctx) ? mcpApps : chatgpt)

export const directoryTitleAndHints: Rule = {
  id: 'directory/title-and-hints',
  description: 'Every tool has a title and the applicable hint (readOnlyHint: true for reads; destructiveHint for writes) — hard directory requirement',
  source: '§9',
  hosts: ['mcp-apps'],
  check(ctx) {
    const out: Finding[] = []
    for (const t of ctx.tools) {
      const a = annotationsOf(t)
      const title = t.title ?? a.title
      if (typeof title !== 'string' || title.trim().length === 0) {
        out.push({rule: this.id, severity: 'fail', target: t.name, source: this.source, message: 'no title', hint: 'Claude uses the title in permission prompts; the directory rejects tools without one.'})
      }
      const hasApplicable = a.readOnlyHint === true || typeof a.destructiveHint === 'boolean'
      if (!hasApplicable) {
        out.push({rule: this.id, severity: 'fail', target: t.name, source: this.source, message: 'no applicable hint (readOnlyHint: true for read tools, destructiveHint for write tools)', hint: 'These drive auto-permissions in Claude: read-only tools run without per-call confirmation; destructive tools always prompt.'})
      }
    }
    return out
  },
}

const CATCH_ALL_NAME = /^(api|http|raw|rest|generic)[_-]?(request|call|fetch)$|^(request|fetch_url|call_endpoint)$/i

export const directoryNoCatchAll: Rule = {
  id: 'directory/no-catch-all-tool',
  description: 'No catch-all tool that takes an HTTP method/endpoint (split into read and write tools)',
  source: '§9',
  check(ctx) {
    const out: Finding[] = []
    for (const t of ctx.tools) {
      const props = ((t.inputSchema as Record<string, unknown> | undefined)?.properties ?? {}) as Record<string, Record<string, unknown>>
      const methodProp = props.method ?? props.http_method ?? props.httpMethod
      const methodEnum = Array.isArray(methodProp?.enum) ? (methodProp.enum as string[]).map((m) => String(m).toUpperCase()) : []
      const mixesSafeUnsafe = methodEnum.some((m) => ['GET', 'HEAD', 'OPTIONS'].includes(m)) && methodEnum.some((m) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(m))
      const nameSmells = CATCH_ALL_NAME.test(t.name)
      if (mixesSafeUnsafe || (nameSmells && (methodProp || props.endpoint || props.path || props.url))) {
        out.push({
          rule: this.id, severity: sev(ctx, 'fail', 'warn'), target: t.name, source: this.source,
          message: mixesSafeUnsafe ? `accepts both safe and unsafe HTTP methods (${methodEnum.join('/')})` : 'looks like a generic API pass-through tool',
          hint: 'The Claude directory rejects a single tool that accepts both safe (GET/HEAD/OPTIONS) and unsafe (POST/PUT/PATCH/DELETE) methods. Split into a read-only tool and one or more write tools.',
        })
      }
    }
    return out
  },
}

const INJECTION_PATTERNS: Array<[RegExp, string]> = [
  [/ignore (all |any )?(previous|prior|earlier) (instructions|messages)/i, 'tries to override prior instructions'],
  [/override (the )?(system|developer|host) (prompt|instructions)/i, 'tries to override system instructions'],
  [/takes? precedence over (your|the assistant'?s|any)/i, 'claims precedence over the assistant\'s own instructions'],
  [/regardless of (what )?the user/i, 'directs behaviour regardless of the user'],
  [/do not (call|use|invoke) (any )?(other|external) tools?/i, 'interferes with other tools'],
  [/(always|never) (call|use|invoke) (this|the) tool/i, 'directs tool choice unconditionally'],
  [/(fetch|load|pull|follow) (further |additional |more )?instructions from/i, 'pulls behavioural instructions from an external source'],
  [/upgrade to (pro|premium|plus)|paid (plan|upgrade)|subscribe now/i, 'promotes products/services'],
]

export const directoryPromptInjection: Rule = {
  id: 'directory/prompt-injection',
  description: 'Tool descriptions describe what the tool does — they do not direct the model\'s behaviour, override instructions, or promote products',
  source: '§9',
  check(ctx) {
    const out: Finding[] = []
    for (const t of ctx.tools) {
      const d = typeof t.description === 'string' ? t.description : ''
      for (const [re, why] of INJECTION_PATTERNS) {
        if (re.test(d)) {
          out.push({
            rule: this.id, severity: sev(ctx, 'fail', 'warn'), target: t.name, source: this.source,
            message: `description ${why} (matches /${re.source}/)`,
            hint: 'Anthropic\'s reviewers reject descriptions that tell Claude how to behave. Describe what the tool does and when to use it; move behavioural guidance out.',
          })
          break
        }
      }
    }
    // Server instructions are not tool descriptions, but the same patterns are "close to the line" (RHY-164).
    const instr = ctx.server.instructions ?? ''
    for (const [re, why] of INJECTION_PATTERNS) {
      if (re.test(instr)) {
        out.push({
          rule: this.id, severity: 'warn', target: 'server.instructions', source: this.source,
          message: `server instructions ${why} (matches /${re.source}/)`,
          hint: 'The directory criteria target tool descriptions, but directive server instructions are a related risk — review against docs/apps-sdk-contract.md §9 before submitting.',
        })
        break
      }
    }
    return out
  },
}

export const directoryStandardUiKeys: Rule = {
  id: 'directory/standard-ui-keys',
  description: 'Widget metadata uses the standard MCP Apps keys (ui.resourceUri, ui.csp, ui.domain), not only the openai/* aliases',
  source: '§2, §3, §9',
  hosts: ['mcp-apps'],
  applies: (ctx) => ctx.templates.size > 0 || ctx.tools.some((t) => templateRefOf(t).uri !== undefined),
  check(ctx) {
    const out: Finding[] = []
    for (const t of ctx.tools) {
      const {standard, alias} = templateRefOf(t)
      if (alias && !standard) out.push({rule: this.id, severity: 'fail', target: t.name, source: this.source, message: 'template referenced only via _meta["openai/outputTemplate"]; MCP Apps hosts read _meta.ui.resourceUri', hint: 'Set _meta.ui.resourceUri (keep the alias for ChatGPT).'})
    }
    for (const tmpl of ctx.templates.values()) {
      const src = resourceMetadataSource(tmpl.listed, tmpl.content)
      if (!src) continue
      const csp = cspOf(src)
      if (csp.legacy && !csp.standard) out.push({rule: this.id, severity: 'fail', target: tmpl.uri, source: this.source, message: 'CSP declared only under openai/widgetCSP', hint: 'Declare _meta.ui.csp {connectDomains, resourceDomains, frameDomains}.'})
      const dom = domainOf(src)
      if (dom.legacy && !dom.standard) out.push({rule: this.id, severity: 'fail', target: tmpl.uri, source: this.source, message: 'domain declared only under openai/widgetDomain', hint: 'Declare _meta.ui.domain.'})
    }
    return out
  },
}

export const directoryWindowOpenai: Rule = {
  id: 'directory/window-openai',
  description: 'Widget templates do not depend on window.openai (ChatGPT-only); MCP Apps hosts expose ui/* JSON-RPC over postMessage',
  source: '§6, §9',
  hosts: ['mcp-apps'],
  applies: (ctx) => ctx.templates.size > 0,
  check(ctx) {
    const out: Finding[] = []
    for (const t of ctx.templates.values()) {
      const html = t.content?.text ?? ''
      if (!html) continue
      const uses = /window\.openai\b|\bopenai:set_globals\b/.test(html)
      const guarded = /typeof\s+(window\.openai|api\(\)\.[a-zA-Z]+|openai\.[a-zA-Z]+)\s*[!=]==?\s*["'](function|undefined|object)["']/.test(html)
      const speaksMcpApps = /ui\/initialize|ui\/notifications\/tool-result|ui\/open-link|ui\/message|ui\/request-display-mode/.test(html)
      if (uses && !speaksMcpApps) {
        out.push({
          rule: this.id, severity: guarded ? 'warn' : 'fail', target: t.uri, source: this.source,
          message: guarded
            ? 'template uses window.openai behind typeof guards and has no MCP Apps (ui/*) code path — it will render but be inert on Claude'
            : 'template depends on window.openai and has no MCP Apps (ui/*) code path',
          hint: 'On MCP Apps hosts the view talks JSON-RPC over postMessage: ui/initialize → host context; ui/notifications/tool-result carries structuredContent; tools/call, ui/open-link, ui/message, ui/request-display-mode, ui/notifications/size-changed. Add that path or a shim that works on both hosts.',
        })
      }
      if (/openExternal\s*\(/.test(html) && !/ui\/open-link/.test(html)) {
        out.push({rule: this.id, severity: 'info', target: t.uri, source: this.source, message: 'openExternal({href}) has no MCP Apps equivalent in this template (Claude uses ui/open-link + Allowed link URIs at submission)'})
      }
    }
    return out
  },
}

export const directoryListing: Rule = {
  id: 'directory/listing',
  description: 'Directory listing needs: privacy policy URL, public documentation URL, screenshots (3–5 PNG ≥ 1000 px wide, response only)',
  source: '§9',
  hosts: ['mcp-apps'],
  applies: (ctx) => ctx.config !== undefined,
  check(ctx) {
    const out: Finding[] = []
    const app = ctx.config!.app
    if (!app.privacy_policy_url) out.push({rule: this.id, severity: 'fail', target: 'app.privacy_policy_url', source: this.source, message: 'local app.privacy_policy_url is unset', hint: 'Set the privacy policy URL in ritmo.yaml for Claude directory submission. This checks the local project, not whether the remote service has a policy.'})
    if (!app.support_url && !app.company_url) out.push({rule: this.id, severity: 'warn', target: 'app.support_url', source: this.source, message: 'local support/documentation URL is unset', hint: 'Set app.support_url or app.company_url in ritmo.yaml for Claude directory submission. The remote service website was not checked.'})
    const n = app.screenshots.length
    if (n < 3 || n > 5) out.push({rule: this.id, severity: 'info', target: 'app.screenshots', source: this.source, message: `${n} screenshot${n === 1 ? '' : 's'}; MCP Apps submissions want 3–5 PNGs ≥ 1000 px wide, cropped to the response (no prompt in frame)`})
    return out
  },
}

export const directoryNoAuthScheme: Rule = {
  id: 'directory/auth',
  description: 'Authenticated services must use OAuth 2.0; note noauth tools explicitly',
  source: '§9',
  hosts: ['mcp-apps'],
  check(ctx) {
    const out: Finding[] = []
    const noauth = ctx.tools.filter((t) => JSON.stringify(t.securitySchemes ?? (t._meta as Record<string, unknown> | undefined)?.securitySchemes ?? []).includes('noauth'))
    if (noauth.length > 0 && noauth.length === ctx.tools.length) {
      out.push({rule: this.id, severity: 'info', target: 'server', source: this.source, message: `all ${noauth.length} tools declare noauth — fine for anonymous apps; account-linked features on Claude need OAuth 2.0 (DCR / client-id metadata), not a client-supplied subject`, hint: 'OpenAI-specific subject hints are not portable account identity; use OAuth for authenticated continuity.'})
    }
    return out
  },
}

export const DIRECTORY_RULES: Rule[] = [
  directoryTitleAndHints,
  directoryNoCatchAll,
  directoryPromptInjection,
  directoryStandardUiKeys,
  directoryWindowOpenai,
  directoryListing,
  directoryNoAuthScheme,
]

export function hostLabel(h: HostProfile): string {
  return h === 'mcp-apps' ? 'MCP Apps / Claude' : 'ChatGPT'
}
