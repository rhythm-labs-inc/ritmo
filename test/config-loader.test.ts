import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {ConfigLoadError, loadConfig} from '../src/lib/config-loader.js'

const VALID_YAML = `version: 1

app:
  name: "My App"
  description: "What this app does"
  icon: "./assets/icon.png"
  screenshots:
    - "./assets/screenshots/main.png"
    - "./assets/screenshots/detail.png"
    - "./assets/screenshots/empty.png"

server:
  url: "http://localhost:2091/mcp"

simulate:
  model: "gpt-4o-mini"
  default_context:
    locale: "en-US"
    timezone: "America/New_York"

tests:
  - file: "./tests/smoke.yaml"
`

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'apprhythm-test-'))
})

afterEach(async () => {
  await rm(tmpDir, {force: true, recursive: true})
})

describe('loadConfig', () => {
  it('loads and parses a valid config', async () => {
    await writeFile(path.join(tmpDir, 'apprhythm.yaml'), VALID_YAML)
    const config = await loadConfig(tmpDir)
    expect(config.version).toBe(1)
    expect(config.app.name).toBe('My App')
    expect(config.server.url).toBe('http://localhost:2091/mcp')
    expect(config.simulate.model).toBe('gpt-4o-mini')
    expect(config.tests).toHaveLength(1)
  })

  it('explains a client authentication method without its required secret reference', async () => {
    const invalid = VALID_YAML.replace('url: "http://localhost:2091/mcp"', 'url: "http://localhost:2091/mcp"\n  auth:\n    oauth:\n      client_id: registered\n      token_endpoint_auth_method: client_secret_post')
    await writeFile(path.join(tmpDir, 'apprhythm.yaml'), invalid)
    await expect(loadConfig(tmpDir)).rejects.toMatchObject({details: expect.arrayContaining([expect.stringContaining('client_secret reference')])})
  })

  it('throws ConfigLoadError when file is missing', async () => {
    await expect(loadConfig(tmpDir)).rejects.toThrow(ConfigLoadError)
    await expect(loadConfig(tmpDir)).rejects.toThrow('Config file not found')
  })

  it('throws ConfigLoadError for invalid YAML', async () => {
    await writeFile(path.join(tmpDir, 'apprhythm.yaml'), '{{bad yaml')
    await expect(loadConfig(tmpDir)).rejects.toThrow(ConfigLoadError)
    await expect(loadConfig(tmpDir)).rejects.toThrow('Failed to parse YAML')
  })

  it('throws ConfigLoadError with details for schema violations', async () => {
    const invalidYaml = `version: 2\napp:\n  name: ""\n`
    await writeFile(path.join(tmpDir, 'apprhythm.yaml'), invalidYaml)
    try {
      await loadConfig(tmpDir)
      expect.fail('Expected ConfigLoadError')
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigLoadError)
      const loadError = error as ConfigLoadError
      expect(loadError.details).toBeDefined()
      expect(loadError.details!.length).toBeGreaterThan(0)
    }
  })

  it('rejects config with unknown keys', async () => {
    const yaml = VALID_YAML + 'extra_key: bad\n'
    await writeFile(path.join(tmpDir, 'apprhythm.yaml'), yaml)
    await expect(loadConfig(tmpDir)).rejects.toThrow(ConfigLoadError)
  })

  describe('error details include exact field paths', () => {
    it('reports "version" path for wrong version', async () => {
      const yaml = VALID_YAML.replace('version: 1', 'version: 2')
      await writeFile(path.join(tmpDir, 'apprhythm.yaml'), yaml)
      try {
        await loadConfig(tmpDir)
        expect.fail('Expected ConfigLoadError')
      } catch (error) {
        const e = error as ConfigLoadError
        expect(e.details!.some((d) => d.includes('version:'))).toBe(true)
      }
    })

    it('reports "server.url" path for invalid URL', async () => {
      const yaml = VALID_YAML.replace('http://localhost:2091/mcp', 'ftp://bad')
      await writeFile(path.join(tmpDir, 'apprhythm.yaml'), yaml)
      try {
        await loadConfig(tmpDir)
        expect.fail('Expected ConfigLoadError')
      } catch (error) {
        const e = error as ConfigLoadError
        expect(e.details!.some((d) => d.includes('server.url:'))).toBe(true)
      }
    })

    it('accepts fewer than 3 screenshots (checked by `validate`, not the loader)', async () => {
      const yaml = VALID_YAML
        .replace(
          '    - "./assets/screenshots/main.png"\n    - "./assets/screenshots/detail.png"\n    - "./assets/screenshots/empty.png"',
          '    - "./assets/screenshots/main.png"',
        )
      await writeFile(path.join(tmpDir, 'apprhythm.yaml'), yaml)
      const config = await loadConfig(tmpDir)
      expect(config.app.screenshots).toHaveLength(1)
    })

    it('reports "simulate.default_context.locale" path for empty locale', async () => {
      const yaml = VALID_YAML.replace('locale: "en-US"', 'locale: ""')
      await writeFile(path.join(tmpDir, 'apprhythm.yaml'), yaml)
      try {
        await loadConfig(tmpDir)
        expect.fail('Expected ConfigLoadError')
      } catch (error) {
        const e = error as ConfigLoadError
        expect(e.details!.some((d) => d.includes('simulate.default_context.locale:'))).toBe(true)
      }
    })

    it('includes actionable remediation hints in error details', async () => {
      const yaml = `version: 2\n`
      await writeFile(path.join(tmpDir, 'apprhythm.yaml'), yaml)
      try {
        await loadConfig(tmpDir)
        expect.fail('Expected ConfigLoadError')
      } catch (error) {
        const e = error as ConfigLoadError
        // Every detail line should contain a remediation hint after the → separator
        for (const detail of e.details!) {
          expect(detail).toContain('→')
        }
      }
    })
  })
})
