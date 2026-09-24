import {readFile} from 'node:fs/promises'

import yaml from 'js-yaml'

import {redactSensitiveFields} from '../mcp/redaction.js'
import {terminalHeading, terminalMuted, terminalProse} from './ritmo-terminal.js'

export class InspectionError extends Error {
  readonly category = 'inspection'
  constructor(message: string, readonly hint: string) { super(message) }
}

/** A read-only, redacted view, not schema validation or integrity verification. */
export async function readInspection(file: string, section?: string): Promise<unknown> {
  let data: unknown
  try { data = yaml.load(await readFile(file, 'utf8')) } catch {
    throw new InspectionError(`Could not read JSON/YAML: ${file}`, 'Use a readable JSON or YAML document.')
  }
  data = redactSensitiveFields(data)
  if (section) {
    for (const key of section.split('.')) {
      if (!data || typeof data !== 'object' || !Object.hasOwn(data, key)) {
        throw new InspectionError(`Section "${section}" is absent in ${file}`, 'Run inspect without --section to see the available fields.')
      }
      data = (data as Record<string, unknown>)[key]
    }
  }
  return data ?? null
}

export function formatInspection(data: unknown, title: string, note = 'Read-only view · sensitive fields redacted · integrity not verified'): string {
  const lines = [terminalHeading(title), terminalMuted(note), '']
  function visit(value: unknown, label: string, depth: number): void {
    const indent = '  '.repeat(Math.min(depth, 8))
    if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value)
      lines.push(`${indent}${terminalHeading(label)}${entries.length ? '' : ': (empty)'}`)
      for (const [key, child] of entries) visit(child, Array.isArray(value) ? `[${key}]` : key, depth + 1)
      if (depth < 2) lines.push('')
    } else {
      const text = value === null ? 'null' : String(value)
      lines.push(`${indent}${terminalMuted(label + ':')}`)
      lines.push(terminalProse(text.split('\n').map((line) => `${indent}  ${line}`).join('\n')))
    }
  }
  visit(data, 'Document', 0)
  return lines.join('\n').trimEnd()
}
