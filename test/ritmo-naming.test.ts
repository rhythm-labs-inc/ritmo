import {afterEach, describe, expect, it, vi} from 'vitest'
import {mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {configFilePath, stateDirectory, ritmoEnv, manifestFilePath} from '../src/lib/naming.js'
import {recordValidation} from '../src/lib/cli/builder-history.js'
import {loadConfig} from '../src/lib/config-loader.js'
import {persistSubject, readPersistedSubject} from '../src/lib/mcp/identity.js'

const dirs: string[] = []
const directory = () => {const dir = mkdtempSync(path.join(os.tmpdir(), 'ritmo-naming-')); dirs.push(dir); return dir}
afterEach(() => {vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true})})
describe('Ritmo naming compatibility', () => {
  it('selects one configuration for reads and writes and refuses ambiguity', async () => {
    const dir = directory()
    expect(configFilePath(dir)).toBe(path.join(dir, 'ritmo.yaml'))
    writeFileSync(path.join(dir, 'apprhythm.yaml'), 'version: 1\n')
    expect(configFilePath(dir)).toBe(path.join(dir, 'apprhythm.yaml'))
    writeFileSync(path.join(dir, 'ritmo.yaml'), 'version: 1\n')
    expect(() => configFilePath(dir)).toThrow(/Both ritmo.yaml and apprhythm.yaml/)
    await expect(loadConfig(dir)).rejects.toThrow(/Both ritmo.yaml and apprhythm.yaml/)
    expect(readFileSync(path.join(dir, 'apprhythm.yaml'), 'utf8')).toBe('version: 1\n')
  })
  it('retains legacy identity and writes to the same directory without merging state', () => {
    const dir = directory()
    mkdirSync(path.join(dir, '.apprhythm'))
    writeFileSync(path.join(dir, '.apprhythm/identity.json'), JSON.stringify({subject: 'existing-user'}))
    expect(readPersistedSubject(dir)).toBe('existing-user')
    persistSubject(dir, 'rotated-user')
    expect(readPersistedSubject(dir)).toBe('rotated-user')
    expect(stateDirectory(dir)).toBe(path.join(dir, '.apprhythm'))
    mkdirSync(path.join(dir, '.ritmo'))
    expect(() => readPersistedSubject(dir)).toThrow(/Both .ritmo and .apprhythm/)
    expect(() => persistSubject(dir, 'must-not-write')).toThrow(/Both .ritmo and .apprhythm/)
  })
  it('creates fresh identity in .ritmo', () => {
    const dir = directory()
    persistSubject(dir, 'new-user')
    expect(readFileSync(path.join(dir, '.ritmo/identity.json'), 'utf8')).toContain('new-user')
  })
  it('canonical environment presence wins, including empty and false values', () => {
    expect(ritmoEnv('SUBJECT', {APPRHYTHM_SUBJECT: 'old'})).toBe('old')
    expect(ritmoEnv('SUBJECT', {RITMO_SUBJECT: 'new', APPRHYTHM_SUBJECT: 'old'})).toBe('new')
    expect(ritmoEnv('OPENAI_API_KEY', {RITMO_OPENAI_API_KEY: '', APPRHYTHM_OPENAI_API_KEY: 'old'})).toBe('')
    expect(ritmoEnv('NO_KEYCHAIN', {RITMO_NO_KEYCHAIN: '0', APPRHYTHM_NO_KEYCHAIN: '1'})).toBe('0')
  })
})

it('retains legacy history and honors canonical history controls', async () => {
  const dir = directory()
  mkdirSync(path.join(dir, '.apprhythm'))
  vi.stubEnv('RITMO_NO_HISTORY', undefined)
  vi.stubEnv('APPRHYTHM_NO_HISTORY', undefined)
  await recordValidation([], {endpoint: 'synthetic'}, dir)
  expect(await recordValidation([], {endpoint: 'synthetic'}, dir)).toContain('since your last comparable run')
  const file = path.join(dir, '.apprhythm/terminal-history.json')
  const original = readFileSync(file, 'utf8')
  vi.stubEnv('RITMO_NO_HISTORY', '')
  await recordValidation([], {endpoint: 'changed'}, dir)
  expect(readFileSync(file, 'utf8')).toBe(original)
})
it('selects legacy manifests and rejects ambiguous default baselines', () => {
  const dir = directory()
  expect(manifestFilePath(dir)).toBe(path.join(dir, 'ritmo.manifest.json'))
  writeFileSync(path.join(dir, 'apprhythm.manifest.json'), '{}')
  expect(manifestFilePath(dir)).toBe(path.join(dir, 'apprhythm.manifest.json'))
  writeFileSync(path.join(dir, 'ritmo.manifest.json'), '{}')
  expect(() => manifestFilePath(dir)).toThrow('Both ritmo.manifest.json and apprhythm.manifest.json')
})
it('refuses symlink state directories rather than writing into another project', () => {
  const dir = directory(), target = directory()
  symlinkSync(target, path.join(dir, '.ritmo'))
  expect(() => persistSubject(dir, 'must-not-write')).toThrow('not a symlink')
})
