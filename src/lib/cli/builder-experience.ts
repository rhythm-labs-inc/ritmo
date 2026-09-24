import {stripVTControlCharacters} from 'node:util'
import {terminalColor} from './ritmo-terminal.js'

type Stage = 'Connect' | 'Discover' | 'Test' | 'Package'
type State = 'not run' | 'running' | 'complete' | 'failed' | 'interrupted'

/** Never allow remote labels to inject terminal controls into our live region. */
export function displayText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f]/g, ' ')
}

/** Append-only compact progress: safe across resizing, redirection and terminal themes. */
export class BuilderExperience {
  private readonly stream: NodeJS.WriteStream
  private readonly enabled: boolean
  private branded = false
  private active?: Stage
  private label = ''
  private readonly states: Record<Stage, State> = {Connect: 'not run', Discover: 'not run', Test: 'not run', Package: 'not run'}
  private readonly interrupt = () => { this.dispose(); process.exit(130) }

  constructor(options: {stream?: NodeJS.WriteStream; enabled?: boolean} = {}) {
    this.stream = options.stream ?? process.stdout
    this.enabled = options.enabled ?? true
    if (this.enabled) process.once('SIGINT', this.interrupt)
  }

  start(stage: Stage, label: string): void {
    if (!this.enabled) return
    this.active = stage
    this.states[stage] = 'running'
    this.label = displayText(label)
    this.stream.write(`${this.branded ? '  ' : 'ritmo · '}${stage}: ${this.label}\n`)
    this.branded = true
  }

  update(label: string): void {
    if (!this.enabled) return
    const next = displayText(label)
    if (next === this.label) return
    this.label = next
    this.stream.write(`  ${this.label}\n`)
  }

  finish(stage: Stage, passed = true): void {
    if (!this.enabled) return
    this.states[stage] = passed ? 'complete' : 'failed'
    this.active = undefined
  }

  settle(context: string): void {
    this.update(context)
  }

  fail(): void {
    if (this.active) {
      const stage = this.active
      this.finish(stage, false)
      this.stream.write(`${stage}: failed\n`)
    }
  }

  journey(): void {
    if (!this.enabled) return
    this.stop()
    const rich = this.stream.isTTY && process.env.NO_COLOR === undefined && !process.env.CI && process.env.TERM !== 'dumb'
    const width = Math.max(0, Math.min(88, (this.stream.columns || 80) - 4))
    const parts = Object.entries(this.states).map(([stage, state]) => {
      const hex = state === 'complete' ? '#4FBF95' : state === 'failed' ? '#D9503F' : state === 'running' ? '#6C8FB8' : '#8E9A97'
      const symbol = state === 'complete' ? '✓' : state === 'running' ? '→' : state === 'failed' ? '✗' : '○'
      return terminalColor(hex, rich ? `${symbol} ${stage}` : `${stage}: ${state}`, this.stream)
    })
    if (rich) this.stream.write('\n  ' + terminalColor('#2A3331', '─'.repeat(width), this.stream) + '\n\n')
    this.stream.write('  ' + parts.join((this.stream.columns || 80) < (rich ? 56 : 100) ? '\n  ' : '  ─  ') + '\n')
    if (rich) this.stream.write('\n  ' + terminalColor('#2A3331', '─'.repeat(width), this.stream) + '\n')
  }

  stop(): void { /* Compact stage lines have no live region to clear. */ }
  dispose(): void {
    this.stop()
    if (this.active && this.enabled) {
      this.states[this.active] = 'interrupted'
      this.stream.write(`${this.active}: interrupted\n`)
    }
    this.active = undefined
    process.removeListener('SIGINT', this.interrupt)
  }
}
