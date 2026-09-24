/**
 * Discovery report: how well does the model pick the right tool for each golden prompt?
 * Aggregates a suite tagged with `class: direct|indirect|negative` into per-tool
 * precision / recall, per-class invocation rates and a confusion list.
 *
 * FIDELITY: the simulator drives Chat Completions with our own system prompt; ChatGPT's
 * router differs (indirect prompts may be routed to native features — Rhythm RHY-68 §3).
 * Use this for RELATIVE comparisons (did an instructions change move the numbers?), not
 * absolute invocation rates. Printed in the header on purpose.
 */

import type {SuiteResult} from '../results.js'

export interface ToolStats {
  tool: string
  tp: number
  fp: number
  fn: number
  precision: number | null
  recall: number | null
}

export interface ClassStats {
  class: 'direct' | 'indirect' | 'negative' | 'untagged'
  cases: number
  /** Cases where at least one tool was called (for negative: should be 0). */
  invoked: number
  passed: number
}

export interface DiscoveryReport {
  suiteName: string
  generatedAt: string
  runsPerCase: number
  tools: ToolStats[]
  classes: ClassStats[]
  /** Cases whose called tools differ from the expected set. */
  confusion: Array<{name: string; class?: string; expected: string[]; called: string[]; outcome: string; passRate?: number}>
  totals: {cases: number; passed: number}
}

export function buildDiscoveryReport(suite: SuiteResult, generatedAt = new Date().toISOString()): DiscoveryReport {
  const toolMap = new Map<string, ToolStats>()
  const stat = (t: string) => {
    let s = toolMap.get(t)
    if (!s) { s = {tool: t, tp: 0, fp: 0, fn: 0, precision: null, recall: null}; toolMap.set(t, s) }
    return s
  }
  const classMap = new Map<string, ClassStats>()
  const cls = (c: string) => {
    let s = classMap.get(c)
    if (!s) { s = {class: c as ClassStats['class'], cases: 0, invoked: 0, passed: 0}; classMap.set(c, s) }
    return s
  }
  const confusion: DiscoveryReport['confusion'] = []
  let runsPerCase = 1

  for (const c of suite.cases) {
    const runs = c.runs ?? [{outcome: c.outcome, toolsCalled: c.toolsCalled}]
    runsPerCase = Math.max(runsPerCase, runs.length)
    const expected = new Set(c.expectedTools ?? [])
    const k = cls(c.class ?? 'untagged')
    k.cases++
    if (c.outcome === 'pass') k.passed++
    let anyInvoked = false
    for (const r of runs) {
      const called = new Set(r.toolsCalled)
      if (called.size > 0) anyInvoked = true
      for (const t of expected) {
        if (called.has(t)) stat(t).tp++
        else stat(t).fn++
      }
      for (const t of called) {
        if (!expected.has(t)) stat(t).fp++
      }
    }
    if (anyInvoked) k.invoked++
    const calledUnion = [...new Set(runs.flatMap((r) => r.toolsCalled))]
    const differs = calledUnion.some((t) => !expected.has(t)) || [...expected].some((t) => !calledUnion.includes(t))
    if (differs) confusion.push({name: c.name, class: c.class, expected: [...expected], called: calledUnion, outcome: c.outcome, passRate: c.passRate})
  }

  for (const s of toolMap.values()) {
    s.precision = s.tp + s.fp > 0 ? s.tp / (s.tp + s.fp) : null
    s.recall = s.tp + s.fn > 0 ? s.tp / (s.tp + s.fn) : null
  }

  return {
    suiteName: suite.suiteName,
    generatedAt,
    runsPerCase,
    tools: [...toolMap.values()].sort((a, b) => a.tool.localeCompare(b.tool)),
    classes: [...classMap.values()].sort((a, b) => a.class.localeCompare(b.class)),
    confusion,
    totals: {cases: suite.cases.length, passed: suite.cases.filter((c) => c.outcome === 'pass').length},
  }
}

const pct = (v: number | null) => (v === null ? '  n/a' : `${Math.round(v * 100).toString().padStart(3)}%`)

export function formatDiscoveryReport(r: DiscoveryReport, previous?: DiscoveryReport): string {
  const lines: string[] = []
  lines.push(`Discovery report: ${r.suiteName}${r.runsPerCase > 1 ? ` (${r.runsPerCase} runs per case)` : ''}`)
  lines.push('Fidelity: simulated with Chat Completions + our system prompt; ChatGPT\'s router differs. Compare runs against each other, not against production rates.')
  lines.push('─'.repeat(60))
  lines.push('Per tool           precision  recall   tp  fp  fn' + (previous ? '   Δprec  Δrec' : ''))
  const prev = new Map((previous?.tools ?? []).map((t) => [t.tool, t]))
  for (const t of r.tools) {
    let delta = ''
    if (previous) {
      const p = prev.get(t.tool)
      const d = (a: number | null, b: number | null | undefined) => (a === null || b == null ? '   n/a' : `${(a - b) * 100 >= 0 ? '+' : ''}${Math.round((a - b) * 100)}%`.padStart(6))
      delta = `  ${d(t.precision, p?.precision)} ${d(t.recall, p?.recall)}`
    }
    lines.push(`  ${t.tool.padEnd(18).slice(0, 18)} ${pct(t.precision)}     ${pct(t.recall)}   ${String(t.tp).padStart(2)}  ${String(t.fp).padStart(2)}  ${String(t.fn).padStart(2)}${delta}`)
  }
  lines.push('')
  lines.push('Per class          cases  invoked  passed')
  for (const c of r.classes) {
    lines.push(`  ${c.class.padEnd(18)} ${String(c.cases).padStart(4)}   ${String(c.invoked).padStart(5)}   ${String(c.passed).padStart(5)}${c.class === 'negative' && c.invoked > 0 ? '   ← negative prompts triggered the app' : ''}`)
  }
  if (r.confusion.length > 0) {
    lines.push('')
    lines.push('Confusion (called ≠ expected):')
    for (const c of r.confusion) {
      lines.push(`  ${c.outcome === 'pass' ? '·' : '✗'} ${c.name}${c.class ? ` [${c.class}]` : ''}: expected ${c.expected.length ? c.expected.join(', ') : '(none)'} → called ${c.called.length ? c.called.join(', ') : '(none)'}${c.passRate !== undefined ? ` (pass rate ${Math.round(c.passRate * 100)}%)` : ''}`)
    }
  }
  lines.push('─'.repeat(60))
  lines.push(`${r.totals.passed}/${r.totals.cases} cases passed`)
  return lines.join('\n')
}
