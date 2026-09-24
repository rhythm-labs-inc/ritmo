import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type {Tool} from '@modelcontextprotocol/sdk/types.js'
import {z} from 'zod'

import {McpError, categorizeError} from './errors.js'
import {createConnection, authenticationError, type McpConnection} from './connection.js'
import type {McpAuthConfig} from './auth-schema.js'
import type {OAuthOptions} from './oauth.js'

export const DEFAULT_TIMEOUT_MS = 10_000

export interface McpClientOptions {
  serverUrl: string
  timeoutMs?: number
  auth?: McpAuthConfig
  oauthOptions?: OAuthOptions
}

/**
 * The full MCP `tools/call` result. See docs/apps-sdk-contract.md §4:
 *  - `content` and `structuredContent` are model-visible;
 *  - `_meta` is widget-only and must never be fed to the model.
 */
export interface ToolCallResult {
  content: unknown
  structuredContent?: Record<string, unknown>
  _meta?: Record<string, unknown>
  isError: boolean | undefined
  /** Any other top-level keys the server returned. */
  [key: string]: unknown
}

/** Options for a single tools/call. */
export interface CallToolOptions {
  /** Extra `_meta` to send with the request (e.g. openai/subject, openai/session). */
  meta?: Record<string, unknown>
}

/**
 * A tool descriptor exactly as the server sent it (no SDK schema stripping).
 * The SDK's `listTools()` parses through `ToolSchema`, which drops unknown
 * top-level keys such as `securitySchemes`; `validate` needs them.
 * See docs/apps-sdk-contract.md §2.
 */
export type RawTool = Record<string, unknown> & {name: string}

/** A resource descriptor as sent by the server (`resources/list`). */
export type RawResource = Record<string, unknown> & {uri: string}

/** One entry of a `resources/read` result. */
export interface RawResourceContent {
  uri: string
  mimeType?: string
  text?: string
  blob?: string
  _meta?: Record<string, unknown>
  [key: string]: unknown
}

/** Full resources/read result, retained before HTML extraction (contract §3). */
export interface RawResourceResult extends Record<string, unknown> {
  contents: RawResourceContent[]
}

export interface ServerInfo {
  name?: string
  version?: string
  capabilities: Record<string, unknown>
  instructions?: string
  protocolVersion?: string
}

// Passthrough schemas so `client.request()` returns raw payloads.
const rawToolsListSchema = z.object({
  tools: z.array(z.object({name: z.string()}).passthrough()),
  nextCursor: z.string().optional(),
}).passthrough()

const rawResourcesListSchema = z.object({
  resources: z.array(z.object({uri: z.string()}).passthrough()),
  nextCursor: z.string().optional(),
}).passthrough()

const rawReadResourceSchema = z.object({
  contents: z.array(z.object({uri: z.string()}).passthrough()),
}).passthrough()

const rawCallToolSchema = z.object({
  content: z.array(z.record(z.unknown())).optional(),
  structuredContent: z.record(z.unknown()).optional(),
  isError: z.boolean().optional(),
  _meta: z.record(z.unknown()).optional(),
}).passthrough()

export class McpClient {
  private client: Client | null = null
  private readonly serverUrl: string
  private readonly timeoutMs: number
  private connection?: McpConnection
  private readonly options: McpClientOptions

  constructor(options: McpClientOptions) {
    this.options = options
    this.serverUrl = options.serverUrl
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async connect(): Promise<void> {
    const url = this.validateUrl()

    this.connection = await createConnection(this.serverUrl, this.options.auth, this.options.oauthOptions)
    await this.connection.oauth?.ensureFresh()
    if (this.connection.oauth && !this.connection.oauth.tokens()) throw authenticationError()
    const transport = new StreamableHTTPClientTransport(url, {fetch: this.connection.fetch, authProvider: this.connection.oauth})
    const client = new Client({name: 'ritmo', version: '0.1.0'})

    try {
      await this.withTimeout(
        client.connect(transport),
        'initialize handshake',
      )
    } catch (err) {
      await client.close().catch(() => {})
      throw this.safeError(err)
    }

    this.client = client
  }

  async listTools(): Promise<Tool[]> {
    this.assertConnected()
    try {
      const result = await this.withTimeout(
        this.client!.listTools(),
        'list tools',
      )
      return this.sanitize(result.tools)
    } catch (err) {
      throw this.safeError(err)
    }
  }

  /**
   * `tools/list` with the raw descriptors preserved (follows pagination).
   */
  async listToolsRaw(): Promise<RawTool[]> {
    this.assertConnected()
    const tools: RawTool[] = []
    let cursor: string | undefined
    try {
      do {
        const page = await this.withTimeout(
          this.client!.request(
            {method: 'tools/list', params: cursor ? {cursor} : {}},
            rawToolsListSchema,
          ),
          'list tools',
        )
        tools.push(...(page.tools as RawTool[]))
        cursor = page.nextCursor
      } while (cursor)
      return this.sanitize(tools)
    } catch (err) {
      throw this.safeError(err)
    }
  }

  /**
   * `resources/list` with raw descriptors (follows pagination).
   * Returns `null` when the server does not advertise the `resources` capability.
   */
  async listResourcesRaw(): Promise<RawResource[] | null> {
    this.assertConnected()
    if (!this.hasCapability('resources')) return null
    const resources: RawResource[] = []
    let cursor: string | undefined
    try {
      do {
        const page = await this.withTimeout(
          this.client!.request(
            {method: 'resources/list', params: cursor ? {cursor} : {}},
            rawResourcesListSchema,
          ),
          'list resources',
        )
        resources.push(...(page.resources as RawResource[]))
        cursor = page.nextCursor
      } while (cursor)
      return this.sanitize(resources)
    } catch (err) {
      throw this.safeError(err)
    }
  }

  /**
   * `resources/read` for one URI. Throws McpError('tool-call') when the server
   * rejects the read (unknown URI etc.) so callers can report it as a finding.
   */
  async readResourceRaw(uri: string): Promise<RawResourceContent[]> {
    return (await this.readResourceEnvelope(uri)).contents
  }

  async readResourceEnvelope(uri: string): Promise<RawResourceResult> {
    this.assertConnected()
    try {
      const result = await this.withTimeout(
        this.client!.request({method: 'resources/read', params: {uri}}, rawReadResourceSchema),
        `read resource "${uri}"`,
      )
      return this.sanitize(result) as RawResourceResult
    } catch (err) {
      if (err instanceof McpError) throw err
      const message = this.safeError(err).message
      throw new McpError('tool-call', `resources/read failed for ${uri}: ${message}`)
    }
  }

  /** Server identity, capabilities and `instructions` captured at initialize. */
  getServerInfo(): ServerInfo {
    this.assertConnected()
    const version = this.client!.getServerVersion()
    return this.sanitize({
      name: version?.name,
      version: version?.version,
      capabilities: (this.client!.getServerCapabilities() ?? {}) as Record<string, unknown>,
      instructions: this.client!.getInstructions(),
      protocolVersion: (this.client!.transport as {protocolVersion?: string} | undefined)?.protocolVersion,
    })
  }

  private hasCapability(name: string): boolean {
    const caps = this.client?.getServerCapabilities() as Record<string, unknown> | undefined
    return Boolean(caps && caps[name] !== undefined)
  }

  async callTool(name: string, args: Record<string, unknown>, options: CallToolOptions = {}): Promise<ToolCallResult> {
    this.assertConnected()
    try {
      // Raw request so nothing the server returns is stripped (structuredContent, _meta, extras)
      // and so we control the outbound params._meta.
      const params: Record<string, unknown> = {name, arguments: args}
      if (options.meta && Object.keys(options.meta).length > 0) params._meta = options.meta
      const result = await this.withTimeout(
        this.client!.request({method: 'tools/call', params}, rawCallToolSchema),
        `tool call "${name}"`,
      )
      const {content, structuredContent, isError, _meta, ...rest} = result
      return this.sanitize({
        ...rest,
        content: content ?? [],
        ...(structuredContent !== undefined ? {structuredContent} : {}),
        ...(_meta !== undefined ? {_meta} : {}),
        isError,
      })
    } catch (err) {
      throw this.safeError(err)
    }
  }

  async close(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close()
      } catch {
        // Best-effort cleanup
      }

      this.client = null
    }
  }

  /** Raw transport probes share credentials and redirect policy with MCP requests. */
  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    this.connection ??= await createConnection(this.serverUrl, this.options.auth, this.options.oauthOptions)
    await this.connection.oauth?.ensureFresh()
    return this.connection.fetch(input, init)
  }

  sanitize<T>(value: T): T {
    if (!this.connection) return value
    if (typeof value === 'string') return this.connection.redact(value) as T
    if (Array.isArray(value)) return value.map((item) => this.sanitize(item)) as T
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [this.connection!.redact(key), this.sanitize(item)])) as T
    return value
  }

  private safeError(err: unknown): McpError {
    if (err instanceof McpError) return new McpError(err.category, this.sanitize(err.message), this.sanitize(err.hint))
    if (this.options.auth?.oauth) return authenticationError('The authenticated MCP request failed. Check connectivity or reconnect if the session was rejected.')
    const error = categorizeError(err, this.serverUrl)
    return new McpError(error.category, this.sanitize(error.message), error.hint)
  }

  private validateUrl(): URL {
    let url: URL
    try {
      url = new URL(this.serverUrl)
    } catch {
      throw new McpError(
        'transport',
        `Invalid server URL: ${this.serverUrl}`,
        'Provide a valid HTTP or HTTPS URL, e.g. http://localhost:2091/mcp',
      )
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new McpError(
        'transport',
        `Unsupported transport protocol "${url.protocol}" in ${this.serverUrl}`,
        'Only http:// and https:// URLs are supported in this version.',
      )
    }

    if (url.username || url.password || url.hash || [...url.searchParams.keys()].some((key) => /token|key|auth|secret|password|signature|credential/i.test(key))) {
      throw new McpError('authentication', 'Credential-bearing URLs and fragments are unsupported.', 'Configure server.auth with secret references or OAuth instead.')
    }
    return url
  }

  private assertConnected(): void {
    if (!this.client) {
      throw new McpError(
        'connection',
        'MCP client is not connected. Call connect() first.',
      )
    }
  }

  private withTimeout<T>(promise: Promise<T>, operation: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new McpError(
            'timeout',
            `Timed out after ${this.timeoutMs}ms during ${operation} on ${this.serverUrl}`,
            'Check the server is running. Use --timeout to increase the limit.',
          ),
        )
      }, this.timeoutMs)

      promise.then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (err) => {
          clearTimeout(timer)
          reject(err)
        },
      )
    })
  }
}
