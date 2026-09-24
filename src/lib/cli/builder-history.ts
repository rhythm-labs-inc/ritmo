import {ritmoEnv, stateDirectory} from '../naming.js'
import {createHash, randomUUID} from 'node:crypto'
import {mkdir, readFile, rename, writeFile, rm} from 'node:fs/promises'
import path from 'node:path'
import {z} from 'zod'
import type {Finding, ValidationReport} from '../validate/types.js'
import {terminalStatus, terminalMuted} from './ritmo-terminal.js'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const Run = z.object({scope: z.string(), keys: z.array(z.string()), counts: z.array(z.number().int().nonnegative()).max(8), rules: z.record(z.string().regex(/^[a-z0-9_/-]{1,128}$/i)).optional()}).strict()
type Run = z.infer<typeof Run>

export function findingKeys(reports: Array<{host?: string; findings: Finding[]}>): string[] {
  return [...new Set(reports.flatMap((report) => report.findings.filter((f) => f.severity === 'fail').map((f) => hash([report.host, f.rule, f.target]))))].sort()
}

export function compareRuns(previous: Run | undefined, current: Run): {resolved: number; added: number; counts: number[]} | undefined {
  if (!previous || previous.scope !== current.scope) return undefined
  return {resolved: previous.keys.filter((k) => !current.keys.includes(k)).length, added: current.keys.filter((k) => !previous.keys.includes(k)).length, counts: [...previous.counts, ...current.counts].slice(-8)}
}

/** Local presentation cache only: hashes and counts, never report payloads or credentials. */
export async function recordValidation(reports: ValidationReport[], scope: unknown, cwd = process.cwd()): Promise<string> {
  const fail = reports.reduce((n, r) => n + r.summary.fail, 0)
  const warn = reports.reduce((n, r) => n + r.summary.warn, 0)
  const evaluated = reports.some((r) => r.findings.length > 0)
  const lines = [terminalStatus(fail ? 'fail' : 'pass', `\n${fail} Failed checks. ${!evaluated ? 'No local rules evaluated.' : fail ? 'Local checks need attention.' : 'Local checks passed.'}`), terminalStatus(warn ? 'warn' : 'pass', `${warn} warning${warn === 1 ? ' remains' : 's remain'}.`)]
  if (ritmoEnv('NO_HISTORY') === undefined) {
    const file = path.join(stateDirectory(cwd), 'terminal-history.json')
    const rules = Object.fromEntries(reports.flatMap((r) => r.findings.filter((f) => f.severity === 'fail' && /^[a-z0-9_/-]{1,128}$/i.test(f.rule)).map((f) => [hash([r.host, f.rule, f.target]), f.rule])))
    const current: Run = {scope: hash(scope), keys: findingKeys(reports), counts: [fail], rules}
    let previous: Run | undefined
    try { previous = Run.parse(JSON.parse(await readFile(file, 'utf8'))) } catch { /* absent/incompatible cache */ }
    const delta = compareRuns(previous, current)
    let saved = false
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      await mkdir(path.dirname(file), {recursive: true})
      await writeFile(temporary, JSON.stringify({...current, counts: delta?.counts ?? current.counts}) + '\n', {mode: 0o600, flag: 'wx'})
      await rename(temporary, file)
      saved = true
    } catch { /* presentation history cannot fail validation */ }
    finally { await rm(temporary, {force: true}).catch(() => {}) }
    if (delta) {
      lines.push(`${delta.resolved} failed finding${delta.resolved === 1 ? '' : 's'} resolved since your last comparable run; ${delta.added} new or reopened.`)
      const resolved = [...new Set(previous!.keys.filter((k) => !current.keys.includes(k)).map((k) => previous!.rules?.[k]).filter(Boolean))].slice(0, 3)
      for (const rule of resolved) lines.push(terminalStatus('pass', `  ✓ Resolved finding: ${rule}`))
      const max = Math.max(1, ...delta.counts)
      const spark = '▁▂▃▄▅▆▇█'
      const graphic = process.stdout.isTTY && process.env.NO_COLOR === undefined && !process.env.CI && process.env.TERM !== 'dumb' ? delta.counts.map((n) => spark[Math.round(n / max * 7)]).join(' ') + '  ' : ''
      lines.push(terminalMuted(`Failed checks: ${graphic}${delta.counts.join(' → ')}`))
    } else lines.push(saved ? 'Baseline recorded. No comparable previous run.' : 'History unavailable; this result was not saved.')
    if (delta && !saved) lines.push('History unavailable; this result was not saved.')
  }
  lines.push(terminalMuted('Package not created · real-host approval not established.'))
  return lines.join('\n')
}
