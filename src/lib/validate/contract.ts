/**
 * Runtime contract checks on a single tool result (docs/apps-sdk-contract.md §4).
 * Pure functions; used by `mcp --call`, the simulate loop (trace), the test
 * runner (`assert_contract`), and `validate --probe-tools`.
 *
 *   contract/output-schema        structuredContent validates against the tool's outputSchema
 *   contract/structured-content   outputSchema declared ⇔ structuredContent returned
 *   contract/meta-leak            a widget-only _meta value also appears in model-visible content/structuredContent
 */

import type {ToolCallResult} from '../mcp/client.js'
import {isSensitiveKey} from '../mcp/redaction.js'
import type {Finding} from './types.js'

export interface ContractToolInfo {
  name: string
  outputSchema?: unknown
}

export const CONTRACT_RULE_IDS = ['contract/output-schema', 'contract/structured-content', 'contract/meta-leak'] as const

/** Run every contract check for one tool result. */
export function checkResultContract(tool: ContractToolInfo, result: ToolCallResult): Finding[] {
  const out: Finding[] = []
  const sc = result.structuredContent
  const schema = tool.outputSchema as Record<string, unknown> | undefined

  // structured-content presence vs schema declaration
  if (schema && sc === undefined && !result.isError) {
    out.push({
      rule: 'contract/structured-content', severity: 'warn', target: tool.name, source: '§4',
      message: 'tool declares an outputSchema but returned no structuredContent',
      hint: 'Return `structuredContent` (the model reads it verbatim; the widget gets it as toolOutput), or drop the outputSchema.',
    })
  } else if (!schema && sc !== undefined) {
    out.push({
      rule: 'contract/structured-content', severity: 'warn', target: tool.name, source: '§2, §4',
      message: 'tool returned structuredContent but declares no outputSchema',
      hint: 'Declare an outputSchema; the portal warns per tool without one.',
    })
  }

  // schema conformance
  if (schema && sc !== undefined) {
    const errors = validateAgainstSchema(sc, schema)
    if (errors.length > 0) {
      out.push({
        rule: 'contract/output-schema', severity: 'warn', target: tool.name, source: '§4',
        message: `structuredContent does not match outputSchema: ${errors.slice(0, 5).join('; ')}${errors.length > 5 ? ` (+${errors.length - 5} more)` : ''}`,
        hint: 'Either fix the payload or widen the schema. The portal treats outputSchema as advisory, but the model relies on it.',
      })
    }
  }

  // _meta leak
  const meta = result._meta
  if (meta && typeof meta === 'object') {
    const visible = JSON.stringify({content: result.content ?? null, structuredContent: sc ?? null})
    const leaks: string[] = []
    for (const [path, value, sensitiveKey] of flattenStrings(meta)) {
      // Long values (≥ 12 chars — tokens/ids), or anything under a secret-looking key, must not appear in model-visible fields
      if ((value.length >= 12 || sensitiveKey) && value.length >= 3 && visible.includes(JSON.stringify(value).slice(1, -1))) {
        leaks.push(path)
      }
    }
    if (leaks.length > 0) {
      out.push({
        rule: 'contract/meta-leak', severity: 'fail', target: tool.name, source: '§4',
        message: `widget-only _meta value${leaks.length > 1 ? 's' : ''} also present in model-visible content/structuredContent: ${leaks.join(', ')}`,
        hint: '_meta is hidden from the model; anything the model may see must not be a secret. Keep tokens ONLY in _meta.',
      })
    }
  }

  return out
}

/** [dotted path, string value, key looks sensitive] for every string leaf in an object. */
function flattenStrings(obj: unknown, prefix = '', sensitive = false): Array<[string, string, boolean]> {
  const out: Array<[string, string, boolean]> = []
  if (typeof obj === 'string') {
    out.push([prefix || '(root)', obj, sensitive])
  } else if (Array.isArray(obj)) {
    obj.forEach((v, i) => out.push(...flattenStrings(v, `${prefix}[${i}]`, sensitive)))
  } else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out.push(...flattenStrings(v, prefix ? `${prefix}.${k}` : k, sensitive || isSensitiveKey(k)))
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Minimal JSON Schema validator — the subset MCP tools actually use.
// Supports: type (incl. arrays of types), properties, required, additionalProperties (false / schema),
// items, enum, const, nullable via type array, minItems/maxItems, minLength/maxLength,
// minimum/maximum, oneOf/anyOf/allOf (shallow), $ref to #/definitions|#/$defs.
// Anything it doesn't understand is accepted (no false failures).
// ---------------------------------------------------------------------------

export function validateAgainstSchema(value: unknown, schema: unknown, root?: unknown, path = '$'): string[] {
  const errors: string[] = []
  if (!schema || typeof schema !== 'object') return errors
  const s = schema as Record<string, unknown>
  const rootSchema = root ?? schema

  if (typeof s.$ref === 'string') {
    const resolved = resolveRef(s.$ref, rootSchema)
    return resolved ? validateAgainstSchema(value, resolved, rootSchema, path) : errors
  }

  const type = s.type
  if (type !== undefined) {
    const types = Array.isArray(type) ? (type as string[]) : [type as string]
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(`${path}: expected ${types.join('|')}, got ${describe(value)}`)
      return errors // don't cascade
    }
  }

  if (Array.isArray(s.enum) && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${path}: not one of ${JSON.stringify(s.enum)}`)
  }
  if ('const' in s && JSON.stringify(s.const) !== JSON.stringify(value)) {
    errors.push(`${path}: expected const ${JSON.stringify(s.const)}`)
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    const props = (s.properties ?? {}) as Record<string, unknown>
    if (Array.isArray(s.required)) {
      for (const r of s.required as string[]) {
        if (!(r in obj)) errors.push(`${path}: missing required "${r}"`)
      }
    }
    for (const [k, v] of Object.entries(obj)) {
      if (k in props) {
        errors.push(...validateAgainstSchema(v, props[k], rootSchema, `${path}.${k}`))
      } else if (s.additionalProperties === false) {
        errors.push(`${path}: unexpected property "${k}"`)
      } else if (s.additionalProperties && typeof s.additionalProperties === 'object') {
        errors.push(...validateAgainstSchema(v, s.additionalProperties, rootSchema, `${path}.${k}`))
      }
    }
  }

  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems) errors.push(`${path}: fewer than ${s.minItems} items`)
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) errors.push(`${path}: more than ${s.maxItems} items`)
    if (s.items && typeof s.items === 'object' && !Array.isArray(s.items)) {
      value.forEach((v, i) => errors.push(...validateAgainstSchema(v, s.items, rootSchema, `${path}[${i}]`)))
    }
  }

  if (typeof value === 'string') {
    if (typeof s.minLength === 'number' && value.length < s.minLength) errors.push(`${path}: shorter than ${s.minLength}`)
    if (typeof s.maxLength === 'number' && value.length > s.maxLength) errors.push(`${path}: longer than ${s.maxLength}`)
  }
  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) errors.push(`${path}: below minimum ${s.minimum}`)
    if (typeof s.maximum === 'number' && value > s.maximum) errors.push(`${path}: above maximum ${s.maximum}`)
  }

  for (const key of ['oneOf', 'anyOf'] as const) {
    if (Array.isArray(s[key])) {
      const branches = s[key] as unknown[]
      const ok = branches.some((b) => validateAgainstSchema(value, b, rootSchema, path).length === 0)
      if (!ok) errors.push(`${path}: matches none of ${key}`)
    }
  }
  if (Array.isArray(s.allOf)) {
    for (const b of s.allOf as unknown[]) errors.push(...validateAgainstSchema(value, b, rootSchema, path))
  }

  return errors
}

function matchesType(value: unknown, t: string): boolean {
  switch (t) {
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value)
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: return true
  }
}

function describe(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

function resolveRef(ref: string, root: unknown): unknown {
  const m = /^#\/(definitions|\$defs)\/(.+)$/.exec(ref)
  if (!m || !root || typeof root !== 'object') return undefined
  const defs = (root as Record<string, unknown>)[m[1]] as Record<string, unknown> | undefined
  return defs?.[m[2]]
}
