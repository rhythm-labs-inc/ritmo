/**
 * Manifest diff + resubmission classifier.
 *
 * Reviewed snapshot rules follow current OpenAI maintenance guidance.
 * See docs/apps-sdk-contract.md §3; unknown fields remain explicit warnings.
 * A hash comparison cannot prove backward compatibility of resource contents.
 */

import type {Manifest, ManifestResource, ManifestTool} from './snapshot.js'
import {stableStringify} from './snapshot.js'

export type ChangeClass = 'resubmit' | 'warn' | 'free' | 'info'

export interface Change {
  class: ChangeClass
  /** Dotted path, e.g. `tools.rhythm_builder_guidance._meta.ui.resourceUri` */
  path: string
  message: string
  /** Why it is classified this way (rule id from RULES). */
  rule: string
  before?: unknown
  after?: unknown
}

/**
 * Classification rules, one place. `source` = where we learned it.
 */
export const RULES = {
  'tool/added': {class: 'resubmit', source: 'docs/apps-sdk-contract.md §3 — published manifest changes need re-review'},
  'tool/removed': {class: 'resubmit', source: '[rhythm] as above'},
  'tool/description': {class: 'resubmit', source: '[docs:submit] reviewers check descriptions match behaviour; [rhythm]'},
  'tool/title': {class: 'resubmit', source: '[rhythm] listing/manifest metadata'},
  'tool/inputSchema': {class: 'resubmit', source: '[rhythm] manifest'},
  'tool/outputSchema': {class: 'resubmit', source: '[openai:maintenance] docs/apps-sdk-contract.md §3 — reviewed snapshot'},
  'tool/annotations': {class: 'resubmit', source: '[docs:submit] annotations + justifications are reviewed'},
  'tool/securitySchemes': {class: 'resubmit', source: '[rhythm] auth surface is part of the review'},
  'tool/meta.ui': {class: 'resubmit', source: 'docs/apps-sdk-contract.md §3 — published UI metadata changes need re-review'},
  'tool/meta.other': {class: 'resubmit', source: '[openai:maintenance] docs/apps-sdk-contract.md §3 — reviewed snapshot'},
  'tool/other': {class: 'warn', source: '[unverified] unknown top-level descriptor key changed'},
  'resource/added': {class: 'resubmit', source: '[rhythm] widget resources are part of the manifest'},
  'resource/removed': {class: 'resubmit', source: '[rhythm] as above'},
  'resource/mimeType': {class: 'resubmit', source: '[docs:ux] host only renders text/html;profile=mcp-app'},
  'resource/meta.ui.domain': {class: 'resubmit', source: 'docs/apps-sdk-contract.md §3 — published UI domain metadata'},
  'resource/meta.ui.csp': {class: 'resubmit', source: '[docs:submit] CSP must match exactly; reviewed'},
  'resource/meta.other': {class: 'resubmit', source: '[openai:maintenance] docs/apps-sdk-contract.md §3 — reviewed snapshot'},
  'resource/bytes-same-uri': {class: 'warn', source: '[openai:maintenance] docs/apps-sdk-contract.md §3 — compatible same-URI updates allowed; hash alone cannot prove compatibility'},
  'resource/bytes-new-uri': {class: 'resubmit', source: '[openai:maintenance] docs/apps-sdk-contract.md §3 — reviewed snapshot'},
  'server/instructions': {class: 'resubmit', source: '[openai:maintenance] docs/apps-sdk-contract.md §3 — reviewed snapshot'},
  'server/name-version': {class: 'info', source: 'cosmetic'},
  'server/capabilities': {class: 'warn', source: '[unverified] capability changes (e.g. dropping resources) can break rendering'},
  'app/name': {class: 'resubmit', source: 'docs/apps-sdk-contract.md §8 — listing name is reviewed'},
  'app/subtitle': {class: 'resubmit', source: 'docs/apps-sdk-contract.md §8 — listing subtitle is reviewed'},
} as const satisfies Record<string, {class: ChangeClass; source: string}>

export type RuleId = keyof typeof RULES

function change(rule: RuleId, path: string, message: string, before?: unknown, after?: unknown): Change {
  return {class: RULES[rule].class, rule, path, message: RULES[rule].class === 'resubmit' ? `${message}. Scan, submit and publish an approved version. Keep published contracts available; roll back incompatible server changes.` : message, before, after}
}

function same(a: unknown, b: unknown): boolean {
  return stableStringify(a ?? null) === stableStringify(b ?? null)
}

export function diffManifests(before: Manifest, after: Manifest): Change[] {
  const out: Change[] = []

  // ---- server ----
  if (!same(before.server.instructions, after.server.instructions)) {
    out.push(change('server/instructions', 'server.instructions', 'server instructions changed', before.server.instructions, after.server.instructions))
  }
  if (before.server.name !== after.server.name || before.server.version !== after.server.version) {
    out.push(change('server/name-version', 'server.name/version', `server identity ${before.server.name}@${before.server.version} → ${after.server.name}@${after.server.version}`))
  }
  if (!same(before.server.capabilities, after.server.capabilities)) {
    out.push(change('server/capabilities', 'server.capabilities', 'server capabilities changed', before.server.capabilities, after.server.capabilities))
  }

  // ---- app listing ----
  if (before.app?.name !== after.app?.name && (before.app || after.app)) {
    out.push(change('app/name', 'app.name', 'listing name changed', before.app?.name, after.app?.name))
  }
  if (before.app?.subtitle !== after.app?.subtitle && (before.app || after.app)) {
    out.push(change('app/subtitle', 'app.subtitle', 'listing subtitle changed', before.app?.subtitle, after.app?.subtitle))
  }

  // ---- tools ----
  const bt = new Map(before.tools.map((t) => [t.name, t]))
  const at = new Map(after.tools.map((t) => [t.name, t]))
  for (const [name] of bt) if (!at.has(name)) out.push(change('tool/removed', `tools.${name}`, `tool removed: ${name}`))
  for (const [name] of at) if (!bt.has(name)) out.push(change('tool/added', `tools.${name}`, `tool added: ${name}`))
  for (const [name, b] of bt) {
    const a = at.get(name)
    if (a) out.push(...diffTool(b, a))
  }

  // ---- resources ----
  const br = new Map(before.resources.map((r) => [r.uri, r]))
  const ar = new Map(after.resources.map((r) => [r.uri, r]))
  for (const [uri] of br) if (!ar.has(uri)) out.push(change('resource/removed', `resources.${uri}`, `widget resource removed: ${uri}`))
  for (const [uri, r] of ar) {
    if (!br.has(uri)) {
      out.push(change('resource/added', `resources.${uri}`, `widget resource added: ${uri}`))
      // A new URI remains a reviewed contract change; retain the old resource.
      const prevSame = [...br.values()].find((p) => p.sha256 && r.sha256 && p.sha256 !== r.sha256 && sameFamily(p.uri, uri))
      if (prevSame) out.push(change('resource/bytes-new-uri', `resources.${uri}`, `template content has a new URI (was ${prevSame.uri}); submit and publish the approved version, retaining the old URI`, prevSame.sha256, r.sha256))
    }
  }
  for (const [uri, b] of br) {
    const a = ar.get(uri)
    if (a) out.push(...diffResource(b, a))
  }

  return out
}

function diffTool(b: ManifestTool, a: ManifestTool): Change[] {
  const out: Change[] = []
  const bd = b.descriptor as Record<string, unknown>
  const ad = a.descriptor as Record<string, unknown>
  const p = `tools.${b.name}`
  const simple: Array<[string, RuleId]> = [
    ['description', 'tool/description'],
    ['title', 'tool/title'],
    ['inputSchema', 'tool/inputSchema'],
    ['outputSchema', 'tool/outputSchema'],
    ['annotations', 'tool/annotations'],
    ['securitySchemes', 'tool/securitySchemes'],
  ]
  for (const [key, rule] of simple) {
    if (!same(bd[key], ad[key])) out.push(change(rule, `${p}.${key}`, `${key} changed`, bd[key], ad[key]))
  }
  // All tool _meta fields are part of the reviewed snapshot (contract §3).
  const bm = (bd._meta ?? {}) as Record<string, unknown>
  const am = (ad._meta ?? {}) as Record<string, unknown>
  const UI_KEYS = new Set(['ui', 'openai/outputTemplate', 'openai/widgetAccessible', 'openai/visibility', 'securitySchemes'])
  for (const key of new Set([...Object.keys(bm), ...Object.keys(am)])) {
    if (same(bm[key], am[key])) continue
    if (key === 'ui') {
      const bu = (bm.ui ?? {}) as Record<string, unknown>
      const au = (am.ui ?? {}) as Record<string, unknown>
      for (const uk of new Set([...Object.keys(bu), ...Object.keys(au)])) {
        if (!same(bu[uk], au[uk])) out.push(change('tool/meta.ui', `${p}._meta.ui.${uk}`, `_meta.ui.${uk} changed`, bu[uk], au[uk]))
      }
    } else if (UI_KEYS.has(key)) {
      out.push(change(key === 'securitySchemes' ? 'tool/securitySchemes' : 'tool/meta.ui', `${p}._meta.${key}`, `_meta.${key} changed`, bm[key], am[key]))
    } else {
      out.push(change('tool/meta.other', `${p}._meta.${key}`, `_meta.${key} changed`, bm[key], am[key]))
    }
  }
  const KNOWN = new Set(['name', 'description', 'title', 'inputSchema', 'outputSchema', 'annotations', 'securitySchemes', '_meta'])
  for (const key of new Set([...Object.keys(bd), ...Object.keys(ad)])) {
    if (KNOWN.has(key)) continue
    if (!same(bd[key], ad[key])) out.push(change('tool/other', `${p}.${key}`, `${key} changed`, bd[key], ad[key]))
  }
  return out
}

function diffResource(b: ManifestResource, a: ManifestResource): Change[] {
  const out: Change[] = []
  const p = `resources.${b.uri}`
  if (b.mimeType !== a.mimeType) out.push(change('resource/mimeType', `${p}.mimeType`, 'mimeType changed', b.mimeType, a.mimeType))
  const bm = (b._meta ?? {}) as Record<string, unknown>
  const am = (a._meta ?? {}) as Record<string, unknown>
  const bu = (bm.ui ?? {}) as Record<string, unknown>
  const au = (am.ui ?? {}) as Record<string, unknown>
  for (const uk of new Set([...Object.keys(bu), ...Object.keys(au)])) {
    if (same(bu[uk], au[uk])) continue
    const rule: RuleId = uk === 'domain' ? 'resource/meta.ui.domain' : uk === 'csp' ? 'resource/meta.ui.csp' : 'resource/meta.other'
    out.push(change(rule, `${p}._meta.ui.${uk}`, `_meta.ui.${uk} changed`, bu[uk], au[uk]))
  }
  for (const key of new Set([...Object.keys(bm), ...Object.keys(am)])) {
    if (key === 'ui' || same(bm[key], am[key])) continue
    const rule: RuleId = key === 'openai/widgetDomain' ? 'resource/meta.ui.domain' : key === 'openai/widgetCSP' ? 'resource/meta.ui.csp' : 'resource/meta.other'
    out.push(change(rule, `${p}._meta.${key}`, `_meta.${key} changed`, bm[key], am[key]))
  }
  if (b.sha256 && a.sha256 && b.sha256 !== a.sha256) {
    out.push(change('resource/bytes-same-uri', `${p}.sha256`, `template bytes changed at the same URI; verify backward compatibility with the published contract. Compatible updates need no review; cached contents may persist for up to one hour`, b.sha256, a.sha256))
  }
  return out
}

/** Heuristic: two URIs belong to the same versioned family if they match after stripping a trailing digest/version. */
function sameFamily(a: string, b: string): boolean {
  const strip = (u: string) => u.replace(/[-_.](?:[0-9a-f]{6,}|v\d+)(?=\.[a-z]+$|$)/i, '')
  return strip(a) === strip(b) && a !== b
}

export interface DiffSummary {
  resubmit: number
  warn: number
  free: number
  info: number
}

export function summarizeChanges(changes: Change[]): DiffSummary {
  const s: DiffSummary = {resubmit: 0, warn: 0, free: 0, info: 0}
  for (const c of changes) s[c.class]++
  return s
}

export type DiffFailOn = 'resubmit' | 'warn' | 'never'

export function diffShouldFail(changes: Change[], failOn: DiffFailOn): boolean {
  if (failOn === 'never') return false
  return changes.some((c) => c.class === 'resubmit' || (failOn === 'warn' && c.class === 'warn'))
}

export function formatDiff(changes: Change[], opts: {before: string; after: string}): string {
  const lines: string[] = []
  const s = summarizeChanges(changes)
  lines.push(`Manifest diff: ${opts.before} → ${opts.after}`)
  lines.push('─'.repeat(60))
  if (changes.length === 0) {
    lines.push('No changes.')
  } else {
    const order: ChangeClass[] = ['resubmit', 'warn', 'free', 'info']
    const label: Record<ChangeClass, string> = {resubmit: 'REQUIRES RESUBMISSION', warn: 'WARN', free: 'deploys freely', info: 'info'}
    for (const cls of order) {
      const group = changes.filter((c) => c.class === cls)
      if (group.length === 0) continue
      lines.push(`${label[cls]} (${group.length})`)
      for (const c of group) {
        lines.push(`  • ${c.path}: ${c.message}   [${c.rule}]`)
        if (c.before !== undefined || c.after !== undefined) {
          const b = preview(c.before)
          const a = preview(c.after)
          if (b !== a) lines.push(`      ${b}  →  ${a}`)
        }
      }
    }
  }
  lines.push('─'.repeat(60))
  lines.push(`${s.resubmit} require resubmission · ${s.warn} warning${s.warn === 1 ? '' : 's'} · ${s.free} free · ${s.info} info`)
  if (s.resubmit > 0) lines.push('Publish the approved version to update the reviewed snapshot. Keep published contracts available; review does not make breaking live changes safe.')
  return lines.join('\n')
}

function preview(v: unknown): string {
  if (v === undefined) return '(absent)'
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > 80 ? s.slice(0, 77) + '…' : s
}
