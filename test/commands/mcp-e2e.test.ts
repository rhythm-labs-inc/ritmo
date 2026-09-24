/**
 * `mcp --call` against the in-process fixture server: full result printed.
 */
import {execFile} from 'node:child_process'
import path from 'node:path'
import {promisify} from 'node:util'

import {afterAll, beforeAll, describe, expect, it} from 'vitest'

import {compliantSpec, startFixtureServer, type FixtureServer} from '../helpers/fixture-server.js'

const exec = promisify(execFile)
const BIN = path.resolve(__dirname, '../../bin/run.js')

describe('mcp --call end-to-end', () => {
  let srv: FixtureServer

  beforeAll(async () => {
    srv = await startFixtureServer({
      ...compliantSpec(),
      onCallTool: (name, args) => ({
        content: [{type: 'text', text: `ran ${name}`}],
        structuredContent: {got: args},
        _meta: {sessionToken: 'abc123'},
      }),
    })
  })
  afterAll(async () => { await srv.close() })

  it('prints static discovery cards when interactive mode is requested through a pipe', async () => {
    const before = srv.calls.length
    const result = await exec('node', [BIN, 'mcp', '--server', srv.url, '--list-tools', '--interactive'])
    expect(result.stdout).toContain('Your app, at a glance.')
    expect(result.stdout).toContain('Discover: complete')
    expect(result.stdout).toContain('Test: not run')
    expect(result.stdout).toContain('MAY WRITE')
    expect(result.stdout).not.toContain('Tool number + Enter')
    expect(result.stdout).not.toContain('\u001b')
    expect(srv.calls).toHaveLength(before)
  })

  it('prints content, structuredContent and redacted _meta by default; expanded and redacted with --verbose', async () => {
    const r = await exec('node', [BIN, 'mcp', '--server', srv.url, '--call', 'demo_create_item', '--args', '{"name":"x"}'])
    expect(r.stdout).toContain('ran demo_create_item')
    expect(r.stdout).toContain('structuredContent')
    expect(r.stdout).toContain('[REDACTED]')
    expect(r.stdout).not.toContain('abc123')

    const v = await exec('node', [BIN, 'mcp', '--server', srv.url, '--call', 'demo_create_item', '--args', '{"name":"x"}', '--verbose'])
    expect(v.stdout).not.toContain('abc123')
    expect(srv.calls.at(-1)?.args).toEqual({name: 'x'})
  })
})
