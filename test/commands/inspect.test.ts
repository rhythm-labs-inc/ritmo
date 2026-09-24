import {execFile} from 'node:child_process'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {promisify} from 'node:util'
import {describe, expect, it} from 'vitest'

const run = promisify(execFile)
const bin = path.resolve('bin/run.js')
const env = {...process.env, FORCE_COLOR: '3', NO_COLOR: '1', RITMO_NO_KEYCHAIN: '1'}
describe('RHY-242 inspection and channel contracts', () => {
  it('redacts a nested view and raw export without modifying source bytes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ritmo-inspect-'))
    try {
      const file = path.join(root, 'blueprint.json')
      const bytes = JSON.stringify({delivery: {endpoint: 'https://example.com/mcp', token: 'secret-value'}, items: []})
      await writeFile(file, bytes)
      const human = await run(process.execPath, [bin, 'inspect', file, '--section', 'delivery'], {env})
      expect(human.stdout).toContain('https://example.com/mcp')
      expect(human.stdout).toContain('[REDACTED]')
      expect(human.stdout).toContain('Next step: ritmo inspect --help')
      expect(human.stdout).not.toContain('secret-value')
      expect(human.stdout).not.toContain('\u001b')
      const raw = await run(process.execPath, [bin, 'inspect', file, '--section', 'delivery', '--json'], {env})
      expect(JSON.parse(raw.stdout)).toEqual({endpoint: 'https://example.com/mcp', token: '[REDACTED]'})
      expect(raw.stderr).toBe('')
      expect(await readFile(file, 'utf8')).toBe(bytes)
      await expect(run(process.execPath, [bin, 'inspect', file, '--section', 'absent', '--json'], {env})).rejects.toMatchObject({code: 1, stdout: ''})
    } finally { await rm(root, {recursive: true, force: true}) }
  })
  it('help stays plain when redirected even when FORCE_COLOR is set', async () => {
    const result = await run(process.execPath, [bin, '--help'], {env: {...env, NO_COLOR: undefined}})
    expect(result.stdout).not.toContain('\u001b')
    expect(result.stdout).toContain('inspect')
  })
})

it('keeps config summaries compact while verbose and JSON retain full settings', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ritmo-config-view-'))
  try {
    await run(process.execPath, [bin, 'init', '--no-interactive'], {cwd: root, env})
    const bytes = await readFile(path.join(root, 'ritmo.yaml'), 'utf8')
    const normal = await run(process.execPath, [bin, 'config', 'show'], {cwd: root, env})
    expect(normal.stdout).toContain('Your configuration')
    expect(normal.stdout).toContain('Model for simulation: gpt-4o-mini')
    expect(normal.stdout).toContain('Test file: ./tests/smoke.yaml')
    expect(normal.stdout).toContain("To explore your server's tools, run:\n\n  ritmo mcp --list-tools\n\n")
    expect(normal.stdout).not.toContain('showcase_prompts')
    const verbose = await run(process.execPath, [bin, 'config', 'show', '--verbose'], {cwd: root, env})
    expect(verbose.stdout).toContain('showcase_prompts')
    expect(verbose.stdout).toContain('connection not checked')
    const json = await run(process.execPath, [bin, 'config', 'show', '--json'], {cwd: root, env})
    expect(JSON.parse(json.stdout).simulate.model).toBe('gpt-4o-mini')
    expect(json.stdout).not.toContain('Next step')
    expect(await readFile(path.join(root, 'ritmo.yaml'), 'utf8')).toBe(bytes)
  } finally { await rm(root, {recursive: true, force: true}) }
})
