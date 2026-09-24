import {configFilePath} from '../naming.js'
import {Command} from '@oclif/core'
import {redactCredentialUrls} from '../mcp/redaction.js'

import {terminalColor, terminalNext, terminalProse, terminalStatus, shellArgument} from './ritmo-terminal.js'

/** Explicit human channel. Machine producers continue to use oclif log/write. */
export abstract class RitmoCommand extends Command {
  private printedHuman = false
  private suggestedCommand?: string

  protected inspectNext(file: string): void { this.suggestedCommand = `ritmo inspect ${shellArgument(file)}` }

  protected human(message = ''): void {
    message = redactCredentialUrls(message)
    this.printedHuman = true
    this.log(terminalProse(message.split('\n').map((line) => /^\s*✓/.test(line) ? terminalStatus('pass', line) : /^\s*✗/.test(line) ? terminalStatus('fail', line) : /^\s*!/.test(line) ? terminalStatus('warn', line) : line).join('\n')))
  }

  protected override async catch(error: Error & {oclif?: {exit?: number}; skipOclifErrorHandling?: boolean}): Promise<unknown> {
    error.message = redactCredentialUrls(error.message)
    // Oclif uses an empty exit error for intentional finding-driven exit codes.
    if (error.message && !error.message.startsWith('EEXIT')) {
      const location = redactCredentialUrls(this.inputLocation())
      let display = terminalColor('#D9503F', terminalProse(`✗ ${error.message}\n\n  Location: ${location} (source file/line unavailable)\n  Expected: command inputs and dependencies satisfy the requested operation.\n  Received: the error above.\n  Impact: this operation did not complete; earlier written artifacts may still exist.`, process.stderr.isTTY ? process.stderr.columns || 80 : Infinity), process.stderr)
      display += terminalNext(`ritmo ${this.id?.replaceAll(':', ' ') ?? ''} --help`, process.stderr)
      process.stderr.write(display + '\n')
      error.skipOclifErrorHandling = true
      this.printedHuman = false
    }
    if (this.printedHuman && (error.oclif?.exit ?? 0) > 0) {
      this.human(`\n  Location: ${this.inputLocation()} (source line unavailable)\n  Expected: the requested checks meet their configured completion threshold.\n  Received: unresolved findings shown above.\n  Impact: this run does not establish the requested passing result.`)
    }
    return super.catch(error)
  }

  protected override async finally(error: Error | undefined): Promise<void> {
    if (this.printedHuman) {
      const purpose: Record<string, string> = {init: 'Review your saved setup:', 'config:set': 'Review your updated setup:'}
      if (!error && purpose[this.id ?? '']) this.log(`\n  ${purpose[this.id!]}`)
      this.log(terminalNext(this.nextCommand(), process.stdout, !error && this.id === 'config:show' ? "To explore your server's tools, run:" : undefined))
    }
    await super.finally(error)
    // oclif calls process.exit on errors. Complete queued pipe writes first,
    // including machine reports and stderr diagnostics, without changing exit codes.
    await Promise.all([process.stdout, process.stderr].map((stream) => new Promise<void>((resolve) => {
      if (stream.destroyed || !stream.writable) resolve()
      else stream.write('', () => resolve())
    })))
  }

  private inputLocation(): string {
    const flags = ['--blueprint', '--file', '--bundle', '--server', '--record', '--runner-output']
    for (const flag of flags) {
      const index = this.argv.indexOf(flag)
      if (index >= 0 && this.argv[index + 1]) return this.argv[index + 1]
      const assigned = this.argv.find((arg) => arg.startsWith(flag + '='))
      if (assigned) return assigned.slice(flag.length + 1)
    }
    let file = 'ritmo.yaml / apprhythm.yaml (selection unresolved)'
    try {file = configFilePath()} catch { /* Preserve the original diagnostic. */ }
    return `ritmo ${this.id?.replaceAll(':', ' ') ?? ''} · ${file} (if applicable)`
  }

  protected nextCommand(): string {
    if (this.suggestedCommand) return this.suggestedCommand
    const commands: Record<string, string> = {
      init: 'ritmo config show',
      'config:show': 'ritmo mcp --list-tools',
      'config:set': 'ritmo config show',
      mcp: 'ritmo validate --help',
      validate: 'ritmo validate --help',
      doctor: 'ritmo doctor --help',
      'auth:set-key': 'ritmo auth status',
      'auth:remove-key': 'ritmo auth status',
      'auth:status': 'ritmo simulate --help',
      package: 'ritmo validate --fail-on warn',
      'manifest:snapshot': 'ritmo manifest diff --help',
    }
    return commands[this.id ?? ''] ?? `ritmo ${this.id?.replaceAll(':', ' ') ?? ''} --help`
  }

  override warn(input: Error | string): Error | string {
    const message = input instanceof Error ? input.message : input
    process.stderr.write(terminalColor('#E0B341', terminalProse(`! ${message}`, process.stderr.isTTY ? process.stderr.columns || 80 : Infinity), process.stderr) + '\n')
    return input
  }
}
