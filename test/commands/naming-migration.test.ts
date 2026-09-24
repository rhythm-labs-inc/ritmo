import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdtemp, readFile, rename, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {expect, it} from 'vitest'
const exec = promisify(execFile)
const bin = path.resolve('bin/run.js')
it.each(['ritmo.yaml', 'apprhythm.yaml'])('edits and configures authentication in the selected %s file and refuses both-present writes', async (filename) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ritmo-config-migration-'))
  const run = (...args: string[]) => exec(process.execPath, [bin, ...args], {cwd: root, env: {...process.env, RITMO_NO_KEYCHAIN: '1', RITMO_TEST_TOKEN: 'synthetic-test-value'}})
  try {
    await run('init', '--server-url', 'https://example.com/mcp', '--skip-check', '--no-interactive')
    if (filename === 'apprhythm.yaml') await rename(path.join(root, 'ritmo.yaml'), path.join(root, filename))
    await run('config', 'set', 'server.url', 'https://changed.example/mcp', '--skip-check', '--no-interactive')
    expect((await run('config', 'show', '--verbose')).stdout).toContain(filename)
    await run('auth', 'mcp', '--bearer-env', 'RITMO_TEST_TOKEN')
    const original = await readFile(path.join(root, filename), 'utf8')
    expect(original).toContain('https://changed.example/mcp')
    expect(original).toContain('RITMO_TEST_TOKEN')
    const other = filename === 'ritmo.yaml' ? 'apprhythm.yaml' : 'ritmo.yaml'
    await writeFile(path.join(root, other), 'unrelated: true\n')
    for (const args of [['init', '--force', '--no-interactive'], ['config', 'set', 'server.url', 'https://wrong.example/mcp', '--skip-check', '--no-interactive'], ['auth', 'mcp', '--bearer-env', 'DIFFERENT_TOKEN'], ['config', 'show']]) {
      await expect(run(...args)).rejects.toMatchObject({stderr: expect.stringContaining('Both ritmo.yaml and apprhythm.yaml')})
    }
    expect(await readFile(path.join(root, filename), 'utf8')).toBe(original)
    expect(await readFile(path.join(root, other), 'utf8')).toBe('unrelated: true\n')
  } finally {await rm(root, {recursive: true, force: true})}
})
