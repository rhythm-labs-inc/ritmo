/**
 * In-process MCP fixture server for tests.
 *
 * Serves a configurable set of RAW tool descriptors, resources and server
 * instructions over Streamable HTTP (stateless) on a random localhost port,
 * so command tests and validate/manifest tests can run against a real
 * MCP transport without mocking the SDK client.
 *
 * Usage:
 *   const srv = await startFixtureServer({tools: [...], resources: [...], instructions: '...'})
 *   try { ... srv.url ... } finally { await srv.close() }
 */
import {createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse} from 'node:http'

import {Server} from '@modelcontextprotocol/sdk/server/index.js'
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

export interface FixtureResource {
  /** Override raw envelope hints; {} reproduces the RHY-277 missing-hint response. */
  cacheHints?: Record<string, unknown>
  uri: string
  name?: string
  mimeType?: string
  text?: string
  blob?: string
  _meta?: Record<string, unknown>
  /** Override metadata emitted by resources/list; null omits it. */
  listedMeta?: Record<string, unknown> | null
  /** Override metadata emitted by resources/read; null omits it. */
  readMeta?: Record<string, unknown> | null
  /** If true, resources/read throws for this URI (still listed). */
  unreadable?: boolean
  /** If true, this resource is readable but omitted from resources/list. */
  unlisted?: boolean
}

export interface FixtureServerSpec {
  name?: string
  version?: string
  instructions?: string
  /** Raw tool descriptors, sent exactly as given. */
  tools?: Array<Record<string, unknown> & {name: string}>
  resources?: FixtureResource[]
  /** When false, the server does not advertise the resources capability at all. */
  resourcesCapability?: boolean
  /** Custom tools/call handler. Default: echoes args in structuredContent. Receives the raw params. */
  onCallTool?: (name: string, args: Record<string, unknown>, meta: Record<string, unknown> | undefined) => unknown | Promise<unknown>
  /** Optional hook for every raw HTTP request (before MCP handling). Return true if handled. */
  onHttp?: (req: IncomingMessage, res: ServerResponse) => boolean | Promise<boolean>
}

export interface FixtureServer {
  url: string
  port: number
  /** Every tools/call seen: {name, args, meta}. */
  calls: Array<{name: string; args: Record<string, unknown>; meta: Record<string, unknown> | undefined}>
  /** Every resources/read URI seen. */
  reads: string[]
  close(): Promise<void>
}

export async function startFixtureServer(spec: FixtureServerSpec = {}): Promise<FixtureServer> {
  const calls: FixtureServer['calls'] = []
  const reads: string[] = []
  const resourcesCap = spec.resourcesCapability ?? true

  function buildMcpServer(): Server {
    const server = new Server(
      {name: spec.name ?? 'fixture-server', version: spec.version ?? '0.0.1'},
      {
        capabilities: {
          tools: {},
          ...(resourcesCap ? {resources: {}} : {}),
        },
        instructions: spec.instructions,
      },
    )

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: (spec.tools ?? []) as never,
    }))

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const name = req.params.name
      const args = (req.params.arguments ?? {}) as Record<string, unknown>
      const meta = req.params._meta as Record<string, unknown> | undefined
      calls.push({name, args, meta})
      if (spec.onCallTool) {
        return (await spec.onCallTool(name, args, meta)) as never
      }
      return {
        content: [{type: 'text', text: `called ${name}`}],
        structuredContent: {echo: args},
      } as never
    })

    if (resourcesCap) {
      server.setRequestHandler(ListResourcesRequestSchema, async () => ({
        resources: (spec.resources ?? [])
          .filter((r) => !r.unlisted)
          .map((r) => {
            const meta = r.listedMeta === undefined ? r._meta : r.listedMeta
            return {
              uri: r.uri,
              name: r.name ?? r.uri,
              ...(r.mimeType ? {mimeType: r.mimeType} : {}),
              ...(meta ? {_meta: meta} : {}),
            }
          }) as never,
      }))

      server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
        reads.push(req.params.uri)
        const res = (spec.resources ?? []).find((r) => r.uri === req.params.uri)
        if (!res || res.unreadable) {
          throw new Error(`Resource not found: ${req.params.uri}`)
        }
        const meta = res.readMeta === undefined ? res._meta : res.readMeta
        return {
          ...(res.cacheHints ?? {ttlMs: 0, cacheScope: 'private'}),
          contents: [{
            uri: res.uri,
            ...(res.mimeType ? {mimeType: res.mimeType} : {}),
            ...(res.text !== undefined ? {text: res.text} : {}),
            ...(res.blob !== undefined ? {blob: res.blob} : {}),
            ...(meta ? {_meta: meta} : {}),
          }],
        } as never
      })
    }

    return server
  }

  const httpServer: HttpServer = createServer(async (req, res) => {
    try {
      if (spec.onHttp && (await spec.onHttp(req, res))) return
      // Stateless: fresh server + transport per request
      const transport = new StreamableHTTPServerTransport({sessionIdGenerator: undefined})
      const mcp = buildMcpServer()
      await mcp.connect(transport)
      await transport.handleRequest(req, res)
      res.on('close', () => {
        void transport.close()
        void mcp.close()
      })
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 500
        res.end(JSON.stringify({error: String(err)}))
      }
    }
  })

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()))
  const address = httpServer.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const url = `http://127.0.0.1:${port}/mcp`

  return {
    url,
    port,
    calls,
    reads,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.closeAllConnections?.()
        httpServer.close(() => resolve())
      }),
  }
}

// ---------------------------------------------------------------------------
// Ready-made specs
// ---------------------------------------------------------------------------

export const WIDGET_URI = 'ui://widget/demo-abc12345.html'

/** A well-formed Apps SDK app: 2 tools, one widget template with standard metadata. */
export function compliantSpec(): FixtureServerSpec {
  return {
    name: 'demo-app',
    instructions: 'Use the demo tools when the user asks about demos.',
    tools: [
      {
        name: 'demo_list_items',
        title: 'List demo items',
        description: 'Use this when the user wants to see their demo items. Do not use for creating items.',
        inputSchema: {type: 'object', properties: {}},
        outputSchema: {type: 'object', properties: {items: {type: 'array'}}},
        annotations: {readOnlyHint: true, destructiveHint: false, openWorldHint: false},
        securitySchemes: [{type: 'noauth'}],
        _meta: {
          securitySchemes: [{type: 'noauth'}],
          ui: {resourceUri: WIDGET_URI, visibility: ['model', 'app']},
          'openai/outputTemplate': WIDGET_URI,
          'openai/widgetAccessible': true,
        },
      },
      {
        name: 'demo_create_item',
        title: 'Create demo item',
        description: 'Use this when the user asks to add a new demo item by name.',
        inputSchema: {type: 'object', properties: {name: {type: 'string'}}, required: ['name']},
        outputSchema: {type: 'object', properties: {id: {type: 'string'}}},
        annotations: {readOnlyHint: false, destructiveHint: false, openWorldHint: false},
        securitySchemes: [{type: 'noauth'}],
        _meta: {securitySchemes: [{type: 'noauth'}]},
      },
    ],
    resources: [
      {
        uri: WIDGET_URI,
        name: 'Demo widget',
        mimeType: 'text/html;profile=mcp-app',
        text: '<!doctype html><html><body><div id="root">demo</div><script>window.openai && 0</script></body></html>',
        _meta: {
          'openai/widgetDescription': 'Shows the demo items list.',
          ui: {
            prefersBorder: true,
            domain: 'https://demo.example.com',
            csp: {connectDomains: [], resourceDomains: []},
          },
        },
      },
    ],
  }
}
