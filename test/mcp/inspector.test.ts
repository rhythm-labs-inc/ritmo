import {describe, expect, it} from 'vitest'

import {logCallResult} from '../../src/lib/mcp/inspector.js'

const BASE_OPTIONS = {
  toolName: 'get_weather',
  request: {location: 'New York'},
  latencyMs: 123,
  verbose: false,
}

describe('logCallResult', () => {
  describe('concise mode (default)', () => {
    it('includes timestamp, tool name, status=success, and latency', () => {
      const lines = logCallResult({
        ...BASE_OPTIONS,
        response: {result: 'sunny'},
      })
      const joined = lines.join('\n')
      expect(joined).toMatch(/tool=get_weather/)
      expect(joined).toMatch(/status=success/)
      expect(joined).toMatch(/latency=123ms/)
    })

    it('includes status=error when error is set', () => {
      const lines = logCallResult({
        ...BASE_OPTIONS,
        error: 'Something went wrong',
      })
      const joined = lines.join('\n')
      expect(joined).toMatch(/status=error/)
      expect(joined).toMatch(/Something went wrong/)
    })

    it('includes request preview line', () => {
      const lines = logCallResult({
        ...BASE_OPTIONS,
        response: {result: 'sunny'},
      })
      expect(lines.some((l) => l.includes('req:'))).toBe(true)
    })

    it('includes response preview line on success', () => {
      const lines = logCallResult({
        ...BASE_OPTIONS,
        response: {result: 'sunny'},
      })
      expect(lines.some((l) => l.includes('res:'))).toBe(true)
    })

    it('truncates long request/response previews', () => {
      const bigObj = {data: 'x'.repeat(200)}
      const lines = logCallResult({
        ...BASE_OPTIONS,
        response: bigObj,
        request: bigObj,
      })
      const reqLine = lines.find((l) => l.includes('req:')) ?? ''
      expect(reqLine).toContain('…')
    })
  })

  describe('redaction in default mode', () => {
    it('redacts token field in request', () => {
      const lines = logCallResult({
        ...BASE_OPTIONS,
        request: {token: 'secret-abc', query: 'hello'},
        response: {ok: true},
      })
      const joined = lines.join('\n')
      expect(joined).not.toContain('secret-abc')
      expect(joined).toContain('[REDACTED]')
    })

    it('redacts apiKey field in request', () => {
      const lines = logCallResult({
        ...BASE_OPTIONS,
        request: {apiKey: 'sk-1234', param: 'value'},
        response: {ok: true},
      })
      const joined = lines.join('\n')
      expect(joined).not.toContain('sk-1234')
      expect(joined).toContain('[REDACTED]')
    })

    it('redacts authorization field', () => {
      const lines = logCallResult({
        ...BASE_OPTIONS,
        request: {authorization: 'Bearer xyz'},
        response: {ok: true},
      })
      const joined = lines.join('\n')
      expect(joined).not.toContain('Bearer xyz')
    })

    it('redacts password field', () => {
      const lines = logCallResult({
        ...BASE_OPTIONS,
        request: {password: 'hunter2'},
        response: {ok: true},
      })
      const joined = lines.join('\n')
      expect(joined).not.toContain('hunter2')
    })

    it('redacts secret field', () => {
      const lines = logCallResult({
        ...BASE_OPTIONS,
        request: {secret: 'top-secret'},
        response: {ok: true},
      })
      const joined = lines.join('\n')
      expect(joined).not.toContain('top-secret')
    })

    it('does not redact non-sensitive fields', () => {
      const lines = logCallResult({
        ...BASE_OPTIONS,
        request: {location: 'Paris'},
        response: {weather: 'cloudy'},
      })
      const joined = lines.join('\n')
      expect(joined).toContain('Paris')
      expect(joined).toContain('cloudy')
    })
  })

  describe('verbose mode', () => {
    it('includes full request JSON', () => {
      const lines = logCallResult({
        ...BASE_OPTIONS,
        verbose: true,
        response: {result: 'sunny'},
      })
      const joined = lines.join('\n')
      expect(joined).toContain('"location"')
      expect(joined).toContain('"New York"')
    })

    it('includes full response JSON', () => {
      const lines = logCallResult({
        ...BASE_OPTIONS,
        verbose: true,
        response: {detailed: 'response data'},
      })
      const joined = lines.join('\n')
      expect(joined).toContain('"detailed"')
      expect(joined).toContain('"response data"')
    })

    it('redacts sensitive fields in verbose mode', () => {
      const lines = logCallResult({
        ...BASE_OPTIONS,
        verbose: true,
        request: {token: 'mytoken', location: 'Paris'},
        response: {ok: true},
      })
      const joined = lines.join('\n')
      // Even verbose presentation must not disclose credentials.
      expect(joined).not.toContain('mytoken')
      expect(joined).toContain('[REDACTED]')
    })

    it('shows full error message in verbose mode', () => {
      const lines = logCallResult({
        ...BASE_OPTIONS,
        verbose: true,
        error: 'Detailed error message here',
      })
      const joined = lines.join('\n')
      expect(joined).toContain('Detailed error message here')
    })
  })
})
