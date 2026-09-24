import {describe, expect, it, vi} from 'vitest'
import {chooseServerUrl, validateServerUrl, updateServerUrlText, formatSetupConfirmation} from '../src/lib/config-setup.js'
import yaml from 'js-yaml'

describe('guided server URL setup', () => {
  it('retries invalid input, reports discovered names and asks before saving', async () => {
    const ask = vi.fn().mockResolvedValueOnce('broken').mockResolvedValueOnce('http://localhost:3000/mcp').mockResolvedValueOnce('yes')
    const report = vi.fn(), check = vi.fn().mockResolvedValue(['list_apps'])
    expect(await chooseServerUrl({ask, report, check})).toBe('http://localhost:3000/mcp')
    expect(check).toHaveBeenCalledOnce()
    expect(report.mock.calls.flat().join(' ')).toContain('list_apps')
  })
  it('requires explicit save-later after a failed check', async () => {
    const ask = vi.fn().mockResolvedValueOnce('http://localhost/mcp').mockResolvedValueOnce('save')
    const report = vi.fn()
    await chooseServerUrl({ask, report, check: async () => { throw new Error('SECRET') }})
    expect(report.mock.calls.flat().join(' ')).toContain('not verified')
    expect(report.mock.calls.flat().join(' ')).not.toContain('SECRET')
  })
  it('rejects credentials without including the value in errors', () => {
    for (const url of ['https://user:SECRET@host/mcp', 'https://host/mcp?token=SECRET', 'file:///SECRET']) {
      expect(() => validateServerUrl(url)).toThrow()
      try { validateServerUrl(url) } catch (error) { expect(String(error)).not.toContain('SECRET') }
    }
  })
  it('updates only the URL configuration value without adding defaults', () => {
    const input = {version: 1, app: {name: 'Example', description: 'Description', icon: './icon.png'}, server: {url: 'http://old/mcp'}, simulate: {model: 'gpt-4o-mini', default_context: {locale: 'en-US', timezone: 'UTC'}}, tests: [{file: './custom.yaml'}]}
    const output = yaml.load(updateServerUrlText(yaml.dump(input), 'https://new/mcp'))
    expect(output).toEqual({...input, server: {url: 'https://new/mcp'}})
  })
})

it('checks a live MCP fixture without invoking business tools', async () => {
  const {startFixtureServer} = await import('./helpers/fixture-server.js')
  const {checkServerUrl} = await import('../src/lib/config-setup.js')
  const server = await startFixtureServer({tools: [{name: 'list_apps', inputSchema: {type: 'object'}}]})
  try {
    expect(await checkServerUrl(server.url)).toEqual(['list_apps'])
    expect(server.calls).toHaveLength(0)
  } finally { await server.close() }
})

it('noninteractive failed verification never silently saves and cancellation stops recovery', async () => {
  const check = async () => { throw new Error('secret transport details') }
  await expect(chooseServerUrl({url: 'http://localhost/mcp', report: vi.fn(), check})).rejects.toThrow(/not verified/)
  await expect(chooseServerUrl({url: 'http://localhost/mcp', report: vi.fn(), check, ask: async () => 'cancel'})).rejects.toThrow(/cancelled/)
})

it('accepts Y, N and C confirmation choices and rechecks a changed URL', async () => {
  const ask = vi.fn().mockResolvedValueOnce('https://first.test/mcp').mockResolvedValueOnce('https://second.test/mcp')
  const askChoice = vi.fn().mockResolvedValueOnce('N').mockResolvedValueOnce('Y')
  const check = vi.fn().mockResolvedValue([])
  expect(await chooseServerUrl({ask, askChoice, check, report: vi.fn()})).toBe('https://second.test/mcp')
  expect(check.mock.calls).toEqual([['https://first.test/mcp'], ['https://second.test/mcp']])
  await expect(chooseServerUrl({url: 'https://first.test/mcp', ask, askChoice: async () => 'C', check, report: vi.fn()})).rejects.toThrow('cancelled')
})

it.each(['y', 'N', 'c', '\u0003', '\u0004'])('single-key confirmation restores input mode after %j without Enter', async key => {
  const {PassThrough} = await import('node:stream')
  const {readSetupChoice} = await import('../src/lib/config-setup.js')
  const stream = new PassThrough()
  const input = Object.assign(stream, {isRaw: false, setRawMode: vi.fn((raw: boolean) => { input.isRaw = raw; return input })})
  // Fresh stdin has readableFlowing=null but isPaused()=false.
  // Exercise that state: an explicitly paused stream hid the process-exit bug.
  expect(input.readableFlowing).toBe(null)
  const output = new PassThrough()
  const result = readSetupChoice('Look right?\n', input as unknown as typeof process.stdin, output as typeof process.stdout)
  const expectation = key.charCodeAt(0) < 5 ? expect(result).rejects.toThrow('cancelled') : expect(result).resolves.toBe(key.toLowerCase())
  input.write('invalid pasted text')
  input.write(key)
  await expectation
  expect(input.isRaw).toBe(false)
  expect(input.isPaused()).toBe(true)
  expect(input.listenerCount('data')).toBe(0)
  expect(input.listenerCount('end')).toBe(0)
  expect(input.listenerCount('error')).toBe(0)
})


it('separates setup choices into a readable block without changing their wording', () => {
  // Strip colour so layout stays testable under either terminal environment.
  // eslint-disable-next-line no-control-regex
  const plain = formatSetupConfirmation().replace(/\u001b\[[0-9;]*m/g, '')
  expect(plain).toBe('\n  Look right?\n\n    - Type Y to Continue\n    - Type N to Change the url\n    - Type C to Cancel\n\n  ')
})
