import {stripVTControlCharacters} from 'node:util'

import type {Severity} from '../validate/types.js'

/** See docs/architecture.md: terminal colors remain presentation-only.
 * Four status colours plus muted text; next-step labels use brand green; commands keep the terminal foreground.
 * Data views use the separate six-colour syntax palette. Never use in artifacts.
 */
const COLOR: Record<Severity, string> = {
  pass: '#4FBF95', warn: '#E0B341', info: '#6C8FB8', fail: '#D9503F',
}

// Explicit selection: terminals do not reliably expose their background.
// The light palette uses darker equivalents for contrast on a light background.
const LIGHT: Record<string, string> = {
  '#4FBF95': '#176B4B', '#E0B341': '#765600', '#6C8FB8': '#375C85',
  '#D9503F': '#AD3528', '#8E9A97': '#56635E', '#E0703F': '#99421D',
  '#7FE0BA': '#176B4B',
}

export function terminalColor(hex: string, text: string, stream: NodeJS.WriteStream = process.stdout): string {
  if (!stream.isTTY || process.env.NO_COLOR !== undefined || process.env.TERM === 'dumb' || process.env.CI) return stripVTControlCharacters(text)
  const selected = process.env.RITMO_TERMINAL_THEME === 'light' ? LIGHT[hex.toUpperCase()] ?? hex : hex
  const rgb = selected.slice(1).match(/../g)!.map((part) => Number.parseInt(part, 16))
  return `\u001b[38;2;${rgb.join(';')}m${text}\u001b[0m`
}

export function terminalStatus(severity: Severity, text: string): string {
  return terminalColor(COLOR[severity], text)
}

export function terminalHeading(text: string): string { return text }
export function terminalMuted(text: string): string { return terminalColor('#8E9A97', text) }
export function terminalHint(text: string): string { return terminalColor('#E0703F', text) }
export function terminalWidth(): number { return Math.max(20, process.stdout.columns || 80) }
export function terminalDivider(width = 60): string { return terminalMuted('─'.repeat(Math.min(width, terminalWidth()))) }
export function terminalNext(command: string, stream: NodeJS.WriteStream = process.stdout, purpose?: string): string {
  const arrow = stream.isTTY && process.env.TERM !== 'dumb' ? '→' : '>'
  return `\n  ${terminalColor('#4FBF95', `${arrow} Next step:`, stream)} ${purpose ? stripVTControlCharacters(purpose) + '\n\n  ' : ''}${stripVTControlCharacters(command)}${purpose ? '\n' : ''}`
}

/** Wrap prose only at whitespace. Unbroken paths/URLs and command/data lines
 * deliberately overflow rather than acquire copy-breaking inserted characters.
 */
export function terminalProse(text: string, width = process.stdout.isTTY ? terminalWidth() : Infinity): string {
  let fenced = false
  return text.split('\n').map((original) => {
    const plain = stripVTControlCharacters(original)
    if (plain.trimStart().startsWith('```')) fenced = !fenced
    if (fenced || /```|\b(?:ritmo|apprhythm)\b|^\s*(?:[{}[\]]|"|\$ )/.test(plain)) return terminalSafe(original)
    const indent = plain.match(/^\s*/)?.[0] ?? ''
    const words = plain.trim().split(/\s+/)
    if (plain.length <= width || words.length < 2) return terminalSafe(original)
    const lines: string[] = []
    let line = indent
    for (const word of words) {
      if (line.length > indent.length && line.length + 1 + word.length > width) {
        lines.push(line)
        line = indent + word
      } else line += (line.length > indent.length ? ' ' : '') + word
    }
    lines.push(line)
    // Reapply only the outer semantic colour, never count escapes as columns.
    // eslint-disable-next-line no-control-regex
    const color = original.match(/^\u001b\[38;2;([\d;]+)m/)
    if (color) {
      const hex = '#' + color[1].split(';').map((part) => Number(part).toString(16).padStart(2, '0')).join('')
      return lines.map((part) => terminalColor(hex, part)).join('\n')
    }
    return lines.join('\n')
  }).join('\n')
}

function terminalSafe(text: string): string {
  return !process.stdout.isTTY || process.env.NO_COLOR !== undefined || process.env.CI || process.env.TERM === 'dumb' ? stripVTControlCharacters(text) : text
}

export function terminalCounts(rows: Array<{name: string; pass: number; warn: number; fail: number}>): string {
  if (!rows.length) return ''
  const nameWidth = Math.max(...rows.map((row) => row.name.length))
  const widths = (['pass', 'warn', 'fail'] as const).map((key) => Math.max(...rows.map((row) => String(row[key]).length)))
  const stacked = process.stdout.isTTY && nameWidth + widths.reduce((a, b) => a + b, 0) + 12 > terminalWidth()
  return rows.map((row) => `${stacked ? row.name + '\n ' : row.name.padEnd(nameWidth)}  ${terminalStatus('pass', `✓ ${String(row.pass).padStart(widths[0])}`)}  ${terminalStatus('warn', `! ${String(row.warn).padStart(widths[1])}`)}  ${terminalStatus('fail', `✗ ${String(row.fail).padStart(widths[2])}`)}`).join('\n')
}

/** Syntax only; JSON string contents and whitespace remain unchanged. */
export function terminalData(value: unknown): string {
  const json = JSON.stringify(value, null, 2) ?? 'null'
  return json.replace(/"(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|\b(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/g, (token, offset: number) => {
    const key = token.startsWith('"') && /^\s*:/.test(json.slice(offset + token.length))
    const reference = token.startsWith('"') && /^"(?:https?:|ui:|\/|\.\/)/.test(token)
    return terminalColor(key ? '#8E9A97' : reference ? '#6C8FB8' : token.startsWith('"') ? '#7FE0BA' : '#E0703F', token)
  })
}

/** POSIX shell argument used only for copyable next-command suggestions. */
export function shellArgument(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'" }
