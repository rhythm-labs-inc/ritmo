import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {parseToolArgs} from '../../src/lib/mcp/args.js'
import {McpError} from '../../src/lib/mcp/errors.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'apprhythm-args-'))
})

afterEach(async () => {
  await rm(tmpDir, {force: true, recursive: true})
})

describe('parseToolArgs', () => {
  describe('mutual exclusivity', () => {
    it('throws when both --args and --args-file are provided', async () => {
      await expect(parseToolArgs('{"a":1}', '/some/file.json')).rejects.toSatisfy((err: unknown) => {
        return err instanceof McpError && err.category === 'args' && err.message.includes('mutually exclusive')
      })
    })
  })

  describe('no args provided', () => {
    it('returns empty object when neither --args nor --args-file is given', async () => {
      const result = await parseToolArgs(undefined, undefined)
      expect(result).toEqual({})
    })
  })

  describe('--args (inline JSON)', () => {
    it('parses valid JSON object', async () => {
      const result = await parseToolArgs('{"location":"New York"}', undefined)
      expect(result).toEqual({location: 'New York'})
    })

    it('throws McpError with category "args" for invalid JSON', async () => {
      await expect(parseToolArgs('not-json', undefined)).rejects.toSatisfy((err: unknown) => {
        return err instanceof McpError && err.category === 'args' && err.message.includes('Invalid JSON')
      })
    })

    it('throws McpError when JSON is a non-object (array)', async () => {
      await expect(parseToolArgs('[1,2,3]', undefined)).rejects.toSatisfy((err: unknown) => {
        return err instanceof McpError && err.category === 'args' && err.message.includes('array')
      })
    })

    it('throws McpError when JSON is a non-object (string)', async () => {
      await expect(parseToolArgs('"hello"', undefined)).rejects.toSatisfy((err: unknown) => {
        return err instanceof McpError && err.category === 'args' && err.message.includes('string')
      })
    })
  })

  describe('--args-file', () => {
    it('parses valid JSON object from file', async () => {
      const filePath = path.join(tmpDir, 'args.json')
      await writeFile(filePath, '{"param":"value"}')
      const result = await parseToolArgs(undefined, filePath)
      expect(result).toEqual({param: 'value'})
    })

    it('throws McpError for invalid JSON in file', async () => {
      const filePath = path.join(tmpDir, 'bad.json')
      await writeFile(filePath, '{invalid json}')
      await expect(parseToolArgs(undefined, filePath)).rejects.toSatisfy((err: unknown) => {
        return err instanceof McpError && err.category === 'args' && err.message.includes('Invalid JSON')
      })
    })

    it('throws McpError when file does not exist', async () => {
      await expect(parseToolArgs(undefined, '/nonexistent/file.json')).rejects.toSatisfy((err: unknown) => {
        return err instanceof McpError && err.category === 'args' && err.message.includes('Could not read')
      })
    })

    it('throws McpError when file contains JSON array', async () => {
      const filePath = path.join(tmpDir, 'array.json')
      await writeFile(filePath, '[1,2,3]')
      await expect(parseToolArgs(undefined, filePath)).rejects.toSatisfy((err: unknown) => {
        return err instanceof McpError && err.category === 'args'
      })
    })
  })
})
