import {describe, expect, it} from 'vitest'

import {apprhythmConfigSchema} from '../src/lib/config-schema.js'

function validConfig() {
  return {
    version: 1,
    app: {
      name: 'My App',
      description: 'What this app does',
      icon: './assets/icon.png',
      screenshots: [
        './assets/screenshots/main.png',
        './assets/screenshots/detail.png',
        './assets/screenshots/empty.png',
      ],
    },
    server: {
      url: 'http://localhost:2091/mcp',
    },
    simulate: {
      model: 'gpt-4o-mini',
      default_context: {
        locale: 'en-US',
        timezone: 'America/New_York',
      },
    },
    tests: [{file: './tests/smoke.yaml'}],
  }
}

describe('apprhythmConfigSchema', () => {
  it('accepts a valid config', () => {
    const result = apprhythmConfigSchema.safeParse(validConfig())
    expect(result.success).toBe(true)
  })

  it('accepts https server URL', () => {
    const config = validConfig()
    config.server.url = 'https://myapp.fly.dev/mcp'
    const result = apprhythmConfigSchema.safeParse(config)
    expect(result.success).toBe(true)
  })

  describe('unknown keys', () => {
    it('rejects unknown top-level keys', () => {
      const config = {...validConfig(), extra: 'nope'}
      const result = apprhythmConfigSchema.safeParse(config)
      expect(result.success).toBe(false)
    })

    it('rejects unknown keys in app', () => {
      const config = validConfig()
      ;(config.app as Record<string, unknown>).extra = 'nope'
      const result = apprhythmConfigSchema.safeParse(config)
      expect(result.success).toBe(false)
    })

    it('rejects unknown keys in server', () => {
      const config = validConfig()
      ;(config.server as Record<string, unknown>).timeout = 5000
      const result = apprhythmConfigSchema.safeParse(config)
      expect(result.success).toBe(false)
    })

    it('rejects unknown keys in simulate', () => {
      const config = validConfig()
      ;(config.simulate as Record<string, unknown>).temperature = 0.5
      const result = apprhythmConfigSchema.safeParse(config)
      expect(result.success).toBe(false)
    })

    it('rejects unknown keys in simulate.default_context', () => {
      const config = validConfig()
      ;(config.simulate.default_context as Record<string, unknown>).currency = 'USD'
      const result = apprhythmConfigSchema.safeParse(config)
      expect(result.success).toBe(false)
    })

    it('rejects unknown keys in test entries', () => {
      const config = validConfig()
      ;(config.tests[0] as Record<string, unknown>).timeout = 5000
      const result = apprhythmConfigSchema.safeParse(config)
      expect(result.success).toBe(false)
    })
  })

  describe('missing required fields', () => {
    it('rejects missing version', () => {
      const {version: _version, ...config} = validConfig()
      const result = apprhythmConfigSchema.safeParse(config)
      expect(result.success).toBe(false)
    })

    it('rejects missing app', () => {
      const {app: _app, ...config} = validConfig()
      const result = apprhythmConfigSchema.safeParse(config)
      expect(result.success).toBe(false)
    })

    it('rejects missing app.name', () => {
      const config = validConfig()
      delete (config.app as Record<string, unknown>).name
      const result = apprhythmConfigSchema.safeParse(config)
      expect(result.success).toBe(false)
    })

    it('rejects missing server', () => {
      const {server: _server, ...config} = validConfig()
      const result = apprhythmConfigSchema.safeParse(config)
      expect(result.success).toBe(false)
    })

    it('rejects missing simulate', () => {
      const {simulate: _simulate, ...config} = validConfig()
      const result = apprhythmConfigSchema.safeParse(config)
      expect(result.success).toBe(false)
    })

    it('rejects missing simulate.default_context', () => {
      const config = validConfig()
      delete (config.simulate as Record<string, unknown>).default_context
      const result = apprhythmConfigSchema.safeParse(config)
      expect(result.success).toBe(false)
    })

    it('rejects missing tests', () => {
      const {tests: _tests, ...config} = validConfig()
      const result = apprhythmConfigSchema.safeParse(config)
      expect(result.success).toBe(false)
    })
  })

  describe('invalid types and formats', () => {
    it('rejects version !== 1', () => {
      const config = validConfig()
      ;(config as Record<string, unknown>).version = 2
      const result = apprhythmConfigSchema.safeParse(config)
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues.some((i) => i.message.includes('version must be 1'))).toBe(true)
      }
    })

    it('rejects empty app.name', () => {
      const config = validConfig()
      config.app.name = ''
      const result = apprhythmConfigSchema.safeParse(config)
      expect(result.success).toBe(false)
    })

    it('rejects non-http server URL', () => {
      const config = validConfig()
      config.server.url = 'ftp://server.example.com/mcp'
      const result = apprhythmConfigSchema.safeParse(config)
      expect(result.success).toBe(false)
    })

    it('rejects invalid URL format', () => {
      const config = validConfig()
      config.server.url = 'not-a-url'
      const result = apprhythmConfigSchema.safeParse(config)
      expect(result.success).toBe(false)
    })

    it('accepts fewer than 3 screenshots (listing minimum is a `validate` concern)', () => {
      const config = validConfig()
      config.app.screenshots = ['./one.png', './two.png']
      const result = apprhythmConfigSchema.safeParse(config)
      expect(result.success).toBe(true)
    })

    it('defaults screenshots to an empty array when omitted', () => {
      const config = validConfig() as Record<string, unknown> & {app: Record<string, unknown>}
      delete config.app.screenshots
      const result = apprhythmConfigSchema.safeParse(config)
      expect(result.success).toBe(true)
      if (result.success) expect(result.data.app.screenshots).toEqual([])
    })

    it('rejects empty tests array', () => {
      const config = validConfig()
      config.tests = []
      const result = apprhythmConfigSchema.safeParse(config)
      expect(result.success).toBe(false)
    })

    it('rejects empty string in screenshots array', () => {
      const config = validConfig()
      config.app.screenshots = ['./a.png', '', './c.png']
      const result = apprhythmConfigSchema.safeParse(config)
      expect(result.success).toBe(false)
    })
  })

  describe('error messages include field paths', () => {
    it('includes path for nested validation error', () => {
      const config = validConfig()
      config.simulate.default_context.locale = ''
      const result = apprhythmConfigSchema.safeParse(config)
      expect(result.success).toBe(false)
      if (!result.success) {
        const paths = result.error.issues.map((i) => i.path.join('.'))
        expect(paths).toContain('simulate.default_context.locale')
      }
    })
  })
})
