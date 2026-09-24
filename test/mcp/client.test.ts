import {describe, expect, it, vi, beforeEach} from 'vitest'

import {McpError} from '../../src/lib/mcp/errors.js'

// Mock the MCP SDK before importing our client
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  return {
    Client: vi.fn(),
  }
})

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => {
  return {
    StreamableHTTPClientTransport: vi.fn(),
  }
})

// Import after mocks are set up
const {Client} = await import('@modelcontextprotocol/sdk/client/index.js')
const {StreamableHTTPClientTransport} = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
const {McpClient} = await import('../../src/lib/mcp/client.js')

const MockClient = vi.mocked(Client)
const MockTransport = vi.mocked(StreamableHTTPClientTransport)

function makeClientInstance(overrides: Record<string, unknown> = {}) {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({tools: []}),
    callTool: vi.fn().mockResolvedValue({content: [], isError: false}),
    // callTool goes through the raw request path (keeps structuredContent/_meta)
    request: vi.fn().mockResolvedValue({content: [], isError: false}),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  MockTransport.mockImplementation(function () { return ({} as never) })
})

describe('McpClient', () => {
  describe('URL validation', () => {
    it('throws McpError with category "transport" for non-HTTP URL', async () => {
      MockClient.mockImplementation(function () { return makeClientInstance() as never })
      const client = new McpClient({serverUrl: 'ws://localhost:9000'})
      await expect(client.connect()).rejects.toSatisfy((err: unknown) => {
        return err instanceof McpError && err.category === 'transport'
      })
    })

    it('throws McpError with category "transport" for invalid URL', async () => {
      MockClient.mockImplementation(function () { return makeClientInstance() as never })
      const client = new McpClient({serverUrl: 'not-a-url'})
      await expect(client.connect()).rejects.toSatisfy((err: unknown) => {
        return err instanceof McpError && err.category === 'transport'
      })
    })

    it('accepts http:// URLs', async () => {
      MockClient.mockImplementation(function () { return makeClientInstance() as never })
      const client = new McpClient({serverUrl: 'http://localhost:2091/mcp'})
      await expect(client.connect()).resolves.toBeUndefined()
    })

    it('accepts https:// URLs', async () => {
      MockClient.mockImplementation(function () { return makeClientInstance() as never })
      const client = new McpClient({serverUrl: 'https://myapp.fly.dev/mcp'})
      await expect(client.connect()).resolves.toBeUndefined()
    })
  })

  describe('connect / initialize handshake', () => {
    it('resolves on successful connect', async () => {
      MockClient.mockImplementation(function () { return makeClientInstance() as never })
      const client = new McpClient({serverUrl: 'http://localhost:2091/mcp'})
      await expect(client.connect()).resolves.toBeUndefined()
    })

    it('throws categorized McpError when connect throws ECONNREFUSED', async () => {
      const instance = makeClientInstance({
        connect: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      })
      MockClient.mockImplementation(function () { return instance as never })
      const client = new McpClient({serverUrl: 'http://localhost:9999/mcp'})
      await expect(client.connect()).rejects.toSatisfy((err: unknown) => {
        return err instanceof McpError && err.category === 'connection'
      })
    })

    it('throws McpError with category "timeout" when connect exceeds timeout', async () => {
      const instance = makeClientInstance({
        connect: vi.fn().mockImplementation(() => new Promise(() => {})), // never resolves
      })
      MockClient.mockImplementation(function () { return instance as never })
      const client = new McpClient({serverUrl: 'http://localhost:2091/mcp', timeoutMs: 50})
      await expect(client.connect()).rejects.toSatisfy((err: unknown) => {
        return err instanceof McpError && err.category === 'timeout'
      })
    }, 3000)
  })

  describe('listTools', () => {
    it('returns tools from the server', async () => {
      const tools = [{name: 'my_tool', description: 'does stuff', inputSchema: {type: 'object' as const, properties: {}}}]
      const instance = makeClientInstance({
        listTools: vi.fn().mockResolvedValue({tools}),
      })
      MockClient.mockImplementation(function () { return instance as never })

      const client = new McpClient({serverUrl: 'http://localhost:2091/mcp'})
      await client.connect()
      const result = await client.listTools()
      expect(result).toEqual(tools)
    })

    it('throws McpError on listTools failure', async () => {
      const instance = makeClientInstance({
        listTools: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      })
      MockClient.mockImplementation(function () { return instance as never })

      const client = new McpClient({serverUrl: 'http://localhost:2091/mcp'})
      await client.connect()
      await expect(client.listTools()).rejects.toBeInstanceOf(McpError)
    })

    it('times out if listTools hangs', async () => {
      const instance = makeClientInstance({
        listTools: vi.fn().mockImplementation(() => new Promise(() => {})),
      })
      MockClient.mockImplementation(function () { return instance as never })

      const client = new McpClient({serverUrl: 'http://localhost:2091/mcp', timeoutMs: 50})
      await client.connect()
      await expect(client.listTools()).rejects.toSatisfy((err: unknown) => {
        return err instanceof McpError && err.category === 'timeout'
      })
    }, 3000)
  })

  describe('callTool', () => {
    it('returns content from a successful tool call', async () => {
      const content = [{type: 'text', text: 'result'}]
      const instance = makeClientInstance({
        request: vi.fn().mockResolvedValue({content, isError: false}),
      })
      MockClient.mockImplementation(function () { return instance as never })

      const client = new McpClient({serverUrl: 'http://localhost:2091/mcp'})
      await client.connect()
      const result = await client.callTool('my_tool', {param: 'val'})
      expect(result.content).toEqual(content)
    })

    it('returns structuredContent and _meta untouched, and sends options.meta as params._meta', async () => {
      const request = vi.fn().mockResolvedValue({
        content: [{type: 'text', text: 'ok'}],
        structuredContent: {phase: 'complete'},
        _meta: {rhythmSessionToken: 'secret'},
        isError: false,
        extra: 1,
      })
      MockClient.mockImplementation(function () { return makeClientInstance({request}) as never })

      const client = new McpClient({serverUrl: 'http://localhost:2091/mcp'})
      await client.connect()
      const result = await client.callTool('t', {a: 1}, {meta: {'openai/subject': 'u1'}})
      expect(result.structuredContent).toEqual({phase: 'complete'})
      expect(result._meta).toEqual({rhythmSessionToken: 'secret'})
      expect(result.extra).toBe(1)
      expect(request).toHaveBeenCalledWith(
        {method: 'tools/call', params: {name: 't', arguments: {a: 1}, _meta: {'openai/subject': 'u1'}}},
        expect.anything(),
      )
      // no meta → no params._meta key at all
      await client.callTool('t', {})
      expect(request.mock.calls[1][0]).toEqual({method: 'tools/call', params: {name: 't', arguments: {}}})
    })

    it('passes through isError from the SDK', async () => {
      const instance = makeClientInstance({
        request: vi.fn().mockResolvedValue({content: [], isError: true}),
      })
      MockClient.mockImplementation(function () { return instance as never })

      const client = new McpClient({serverUrl: 'http://localhost:2091/mcp'})
      await client.connect()
      const result = await client.callTool('my_tool', {})
      expect(result.isError).toBe(true)
    })

    it('throws McpError when server is unreachable during call', async () => {
      const instance = makeClientInstance({
        request: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      })
      MockClient.mockImplementation(function () { return instance as never })

      const client = new McpClient({serverUrl: 'http://localhost:2091/mcp'})
      await client.connect()
      await expect(client.callTool('my_tool', {})).rejects.toBeInstanceOf(McpError)
    })

    it('times out if callTool hangs', async () => {
      const instance = makeClientInstance({
        request: vi.fn().mockImplementation(() => new Promise(() => {})),
      })
      MockClient.mockImplementation(function () { return instance as never })

      const client = new McpClient({serverUrl: 'http://localhost:2091/mcp', timeoutMs: 50})
      await client.connect()
      await expect(client.callTool('my_tool', {})).rejects.toSatisfy((err: unknown) => {
        return err instanceof McpError && err.category === 'timeout'
      })
    }, 3000)
  })

  describe('server unavailable', () => {
    it('categorizes ENOTFOUND as a connection error', async () => {
      const instance = makeClientInstance({
        connect: vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND myserver.local')),
      })
      MockClient.mockImplementation(function () { return instance as never })

      const client = new McpClient({serverUrl: 'http://myserver.local/mcp'})
      await expect(client.connect()).rejects.toSatisfy((err: unknown) => {
        return err instanceof McpError && err.category === 'connection'
      })
    })
  })
})
