import {createInterface} from 'node:readline/promises'
import type {RawTool} from '../mcp/client.js'
import {redactSensitiveFields} from '../mcp/redaction.js'
import {annotationsOf, templateRefOf} from '../validate/meta.js'
import {displayText} from './builder-experience.js'
import {terminalData, terminalMuted, terminalProse, terminalColor} from './ritmo-terminal.js'

function cardWidth(): number { return Math.max(24, Math.min(88, (process.stdout.columns || 80) - 4)) }
function divider(): string { return terminalColor('#2A3331', '  ' + '─'.repeat(cardWidth())) }

export function toolCard(tool: RawTool, index: number, expanded: boolean): string {
  const annotations = annotationsOf(tool)
  const {uri} = templateRefOf(tool)
  // Server declarations, not verified guarantees: docs/apps-sdk-contract.md §2–§3.
  const behavior = annotations.readOnlyHint === true ? 'READ' : annotations.readOnlyHint === false ? 'MAY WRITE' : 'BEHAVIOR UNKNOWN'
  const name = `${index + 1} › ${displayText(tool.name)}`
  const badge = `${behavior} · ${uri ? 'WIDGET' : 'NO WIDGET DECLARED'}`
  const room = cardWidth() - name.length - badge.length
  const lines = [room >= 3 ? `  ${name}${' '.repeat(room)}${terminalMuted(badge)}` : `  ${name}\n      ${terminalMuted(badge)}`]
  if (expanded) {
    if (typeof tool.description === 'string') lines.push(terminalProse(`   ${displayText(tool.description)}`))
    lines.push(terminalMuted(`   Server-declared capabilities · widget reference is not a render check`))
    lines.push(`   Widget: ${uri ? displayText(uri) : 'not declared'}`)
    lines.push(terminalData(redactSensitiveFields({annotations, inputSchema: tool.inputSchema ?? 'unknown'})).split('\n').map((line) => '    ' + line).join('\n'))
  }
  return lines.join('\n')
}

export async function showToolCards(tools: RawTool[], interactive: boolean, write: (text: string) => void): Promise<void> {
  write('\n  Your app, at a glance.\n')
  const widgets = new Set(tools.map((tool) => templateRefOf(tool).uri).filter(Boolean))
  write(terminalMuted(`  Found ${tools.length} tool${tools.length === 1 ? '' : 's'} · ${widgets.size} referenced widget${widgets.size === 1 ? '' : 's'} · connection verified`) + '\n')
  const canInteract = interactive && process.stdin.isTTY && process.stdout.isTTY && !process.env.CI && process.env.TERM !== 'dumb'
  tools.forEach((tool, i) => write('\n' + toolCard(tool, i, !canInteract) + '\n\n' + divider()))
  if (!canInteract || !tools.length) return
  const input = createInterface({input: process.stdin, output: process.stdout})
  const controller = new AbortController()
  const expanded = new Set<number>()
  const onInterrupt = () => { controller.abort(); input.close(); process.exitCode = 130 }
  input.once('close', () => controller.abort())
  input.once('SIGINT', onInterrupt)
  try {
    while (!controller.signal.aborted) {
      const answer = await input.question('\n  ' + terminalColor('#E0703F', '[1–' + tools.length + '] Details') + terminalMuted('  ·  [Enter] Done  › '), {signal: controller.signal})
      if (!answer.trim()) break
      const index = Number(answer) - 1
      if (!Number.isInteger(index) || !tools[index]) { write('Choose a tool number from the list.'); continue }
      if (expanded.has(index)) expanded.delete(index)
      else expanded.add(index)
      write(toolCard(tools[index], index, expanded.has(index)) + '\n')
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error
  } finally { input.close() }
}
