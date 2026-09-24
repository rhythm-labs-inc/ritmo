import {readFileSync} from 'node:fs'
import {describe, expect, it} from 'vitest'
import {checkResourceEnvelope} from '../../src/lib/validate/resource-envelope.js'
const fixture = JSON.parse(readFileSync(new URL('../fixtures/mcp/resource-cache.json', import.meta.url), 'utf8'))
const uri = 'ui://widget/example.html'
const check = (result: Record<string, unknown>, host: 'chatgpt' | 'mcp-apps' = 'chatgpt', protocolVersion = '2025-11-25') => checkResourceEnvelope(result, {uri, host, protocolVersion})
describe('resource cache envelope compatibility', () => {
  it('reproduces observed ChatGPT rejection without declaring a stable MCP violation', () => {
    const findings = check(fixture.missing)
    expect(findings.filter(f => f.severity === 'fail').map(f => f.rule)).toEqual(['resource/cache-ttl', 'resource/cache-scope'])
    expect(findings[0].message).toContain('result.ttlMs')
    expect(findings[0].message).toContain('2025-11-25')
    expect(findings[0].source).toContain('RHY-277')
  })
  it('accepts valid hints without leaking widget-only fields', () => {
    expect(check(fixture.valid)).toEqual([])
    expect(JSON.stringify(check(fixture.missing))).not.toContain('do-not-report')
  })
  it('identifies misplaced fields without normalizing them into valid hints', () => {
    const findings = check(fixture.misplaced)
    expect(findings.some(f => f.message.includes('result.contents[0].ttlMs'))).toBe(true)
    expect(findings.filter(f => f.severity === 'fail')).toHaveLength(3)
  })
  it.each([-1, 0.5, '0', null])('rejects invalid TTL %s', ttlMs => {
    expect(check({...fixture.valid, ttlMs}).some(f => f.rule === 'resource/cache-ttl' && f.severity === 'fail')).toBe(true)
  })
  it('does not impose draft-only required fields on portable stable or unknown versions', () => {
    for (const version of ['2024-11-05', '2025-11-25', 'unknown-future']) {
      const findings = check(fixture.missing, 'mcp-apps', version)
      expect(findings.every(f => f.severity === 'info')).toBe(true)
      expect(findings[0].message).toContain(version)
    }
  })
  it('reports malformed optional hints on portable hosts as warnings', () => {
    expect(check(fixture.invalid, 'mcp-apps').filter(f => f.severity === 'warn')).toHaveLength(2)
  })
  it('never certifies public caching as safe for user-specific data', () => {
    const findings = check({...fixture.valid, cacheScope: 'public'})
    expect(findings[0]).toMatchObject({rule: 'resource/cache-public-review', severity: 'warn'})
    expect(findings[0].hint).toContain('private')
  })
  it('does not treat errors or interim results as complete resource reads', () => {
    expect(check({error: {code: -32602}})).toEqual([])
    expect(check({resultType: 'input_required'})).toEqual([])
  })
})
