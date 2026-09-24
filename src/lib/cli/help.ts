import {Help} from '@oclif/core'
import {stripVTControlCharacters} from 'node:util'

import {terminalNext} from './ritmo-terminal.js'

/** Oclif retains its width-aware flags/examples layout; enforce stream policy. */
export default class RitmoHelp extends Help {
  protected override log(...args: string[]): void {
    const plain = !process.stdout.isTTY || process.env.NO_COLOR !== undefined || process.env.CI || process.env.TERM === 'dumb'
    super.log(...args.map((arg) => plain ? stripVTControlCharacters(arg) : arg))
  }
  override async showHelp(argv: string[]): Promise<void> {
    await super.showHelp(argv)
    this.log(terminalNext('ritmo inspect --help'))
  }
}
