import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {getCredentialFromEnv} from '../../src/lib/credentials/env.js'

let savedEnv: Record<string, string | undefined>

beforeEach(() => {
  savedEnv = {...process.env}
  for (const key of Object.keys(process.env)) if (key.startsWith('RITMO_')) delete process.env[key]
})

afterEach(() => {
  // Restore original env
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('APPRHYTHM_') || key.startsWith('RITMO_')) {
      delete process.env[key]
    }
  }

  for (const [key, value] of Object.entries(savedEnv)) {
    if (key.startsWith('APPRHYTHM_') || key.startsWith('RITMO_')) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
})

describe('getCredentialFromEnv', () => {
  it('returns value from APPRHYTHM_OPENAI_API_KEY', () => {
    process.env.APPRHYTHM_OPENAI_API_KEY = 'sk-env-test-123'
    expect(getCredentialFromEnv('openai')).toBe('sk-env-test-123')
  })

  it('returns undefined when env var is not set', () => {
    delete process.env.APPRHYTHM_OPENAI_API_KEY
    expect(getCredentialFromEnv('openai')).toBeUndefined()
  })

  it('returns undefined when env var is empty string', () => {
    process.env.APPRHYTHM_OPENAI_API_KEY = ''
    expect(getCredentialFromEnv('openai')).toBeUndefined()
  })

  it('returns undefined when env var is only whitespace', () => {
    process.env.APPRHYTHM_OPENAI_API_KEY = '   '
    expect(getCredentialFromEnv('openai')).toBeUndefined()
  })

  it('trims whitespace from env var value', () => {
    process.env.APPRHYTHM_OPENAI_API_KEY = '  sk-trimmed  '
    expect(getCredentialFromEnv('openai')).toBe('sk-trimmed')
  })

  it('constructs correct env var name for arbitrary provider', () => {
    process.env.APPRHYTHM_ANTHROPIC_API_KEY = 'sk-ant-test'
    expect(getCredentialFromEnv('anthropic')).toBe('sk-ant-test')
  })

  it('handles uppercase provider normalization via env var name', () => {
    process.env.APPRHYTHM_OPENAI_API_KEY = 'sk-upper'
    // Provider is already lowercase from normalization
    expect(getCredentialFromEnv('openai')).toBe('sk-upper')
  })
})
