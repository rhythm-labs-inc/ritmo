import {createServer} from 'node:http'
import {Server} from '@modelcontextprotocol/sdk/server/index.js'
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema} from '@modelcontextprotocol/sdk/types.js'
import {readFile} from 'node:fs/promises'

const broken = process.argv.includes('--broken')
const portIndex = process.argv.indexOf('--port')
const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 2091
const uri = 'ui://notes/list.html'
const notes = [{id: '1', title: 'Try an MCP tool', body: 'These notes are synthetic fixtures.'}, {id: '2', title: 'Inspect a widget', body: 'No account or model call is needed for this example.'}]
const html = await readFile(new URL('./widget.html', import.meta.url), 'utf8')
const server = createServer(async (req, res) => {
  if (req.url !== '/mcp') { res.writeHead(404).end(); return }
  // Optional fixture authentication. Set the same variable in the Ritmo shell and configure its reference.
  if (process.env.RITMO_EXAMPLE_KEY && req.headers['x-api-key'] !== process.env.RITMO_EXAMPLE_KEY) { res.writeHead(401).end('Authentication required'); return }
  const mcp = new Server({name: 'Ritmo notes example', version: '1.0.0'}, {capabilities: {tools: {}, resources: {}}, instructions: 'Use list_notes to retrieve the synthetic notes. Display their titles and bodies; do not invent notes.'})
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({tools: [{
    name: 'list_notes', title: 'List notes', description: 'Read the synthetic example notes. This only retrieves local fixture data and makes no changes.',
    inputSchema: {type: 'object', properties: {}, additionalProperties: false},
    // See docs/apps-sdk-contract.md §4: describe the returned structuredContent.
    outputSchema: {
      type: 'object', required: ['notes'], additionalProperties: false,
      properties: {notes: {type: 'array', items: {
        type: 'object', required: ['id', 'title', 'body'], additionalProperties: false,
        properties: {id: {type: 'string'}, title: {type: 'string'}, body: {type: 'string'}},
      }}},
    },
    ...(broken ? {} : {annotations: {readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true}}),
    _meta: {ui: {resourceUri: uri, visibility: ['model', 'app']}},
  }]}))
  mcp.setRequestHandler(CallToolRequestSchema, async () => ({content: [{type: 'text', text: notes.map((note) => `${note.title}: ${note.body}`).join('\n')}], structuredContent: {notes}, _meta: {uiOnly: 'Fixture-only widget state'}}))
  mcp.setRequestHandler(ListResourcesRequestSchema, async () => ({resources: [{uri, name: 'Notes', mimeType: 'text/html;profile=mcp-app'}]}))
  mcp.setRequestHandler(ReadResourceRequestSchema, async () => ({ttlMs: 0, cacheScope: 'private', contents: [{uri, mimeType: 'text/html;profile=mcp-app', text: html, _meta: {ui: {prefersBorder: true, domain: 'https://example.com', csp: {connectDomains: [], resourceDomains: []}}}}]}))
  const transport = new StreamableHTTPServerTransport({sessionIdGenerator: undefined})
  try { await mcp.connect(transport); await transport.handleRequest(req, res) }
  catch { if (!res.headersSent) res.writeHead(500).end('Fixture request failed') }
  res.on('close', () => { void transport.close(); void mcp.close() })
})
await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
process.stdout.write(JSON.stringify({url: `http://127.0.0.1:${server.address().port}/mcp`, broken}) + '\n')
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.closeAllConnections(); server.close(() => process.exit(0)) })
