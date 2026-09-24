/**
 * Transport / deploy smoke against ANY MCP URL — raw HTTP + JSON-RPC over fetch,
 * no SDK, no config, no API key. Replaces the hand-typed curl runbook
 * (dated maintainer observations). Contract: docs/apps-sdk-contract.md §1, §3, §8.
 *
 *   collectTransport(url, opts) → TransportProbes   (network)
 *   transportFindings(probes, opts) → Finding[]      (pure)
 */

import {LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS} from '@modelcontextprotocol/sdk/types.js'

import type {Finding} from './types.js'

export interface RpcOutcome {
  status?: number
  contentType?: string
  /** Parsed JSON-RPC body (from JSON or the first SSE `data:` frame), if any. */
  body?: {result?: unknown; error?: {code?: number; message?: string; data?: unknown}; [k: string]: unknown}
  /** Raw text (first 4 KB) for leak scanning. */
  rawPreview?: string
  headers?: Record<string, string>
  error?: string
  durationMs: number
}

export interface TransportProbes {
  url: string
  initialize?: RpcOutcome
  /** initialize with an OLD protocolVersion (negotiation). */
  initializeOld?: RpcOutcome
  get?: RpcOutcome
  options?: RpcOutcome
  delete?: RpcOutcome
  /** initialize with a foreign Origin header. */
  foreignOrigin?: RpcOutcome
  /** initialize with a ~1.5 MB body. */
  bigBody?: RpcOutcome
  malformedJson?: RpcOutcome
  unknownMethod?: RpcOutcome
  unknownTool?: RpcOutcome
  /** N concurrent initialize calls (--hammer). */
  hammer?: {n: number; statuses: number[]; retryAfterSeen: boolean; errors: number}
  /** tools/list + resources/read of each ui:// template + a stale-digest read. */
  templates?: Array<{uri: string; status?: number; mimeType?: string; bytes?: number; error?: string; staleUri?: string; staleResolves?: boolean}>
  toolCount?: number
}

export interface CollectTransportOptions {
  timeoutMs?: number
  fetch?: typeof fetch
  sanitize?: <T>(value: T) => T
  hammer?: number
  /** Skip the 1.5 MB body probe. */
  skipBigBody?: boolean
}

const OLD_PROTOCOL = SUPPORTED_PROTOCOL_VERSIONS.at(-1) ?? '2024-11-05'

async function http(url: string, init: RequestInit & {timeoutMs?: number; fetch?: typeof fetch}): Promise<RpcOutcome> {
  const start = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 8000)
  try {
    const res = await (init.fetch ?? fetch)(url, {...init, signal: controller.signal, redirect: 'manual'})
    const headers: Record<string, string> = {}
    res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v })
    const contentType = headers['content-type']
    let rawPreview: string | undefined
    let body: RpcOutcome['body']
    if (contentType?.includes('text/event-stream')) {
      // read a little of the stream, then cancel
      const reader = res.body?.getReader()
      let text = ''
      if (reader) {
        const deadline = Date.now() + 1500
        while (Date.now() < deadline && text.length < 8192) {
          const chunk = await Promise.race([reader.read(), new Promise<undefined>((r) => setTimeout(() => r(undefined), 300))])
          if (!chunk || chunk.done) break
          text += new TextDecoder().decode(chunk.value)
          if (/\ndata:/.test(text) || text.startsWith('data:')) break
        }
        await reader.cancel().catch(() => {})
      }
      rawPreview = text.slice(0, 4096)
      const data = /^data:\s*(.+)$/m.exec(text)
      if (data) {
        try { body = JSON.parse(data[1]) } catch { /* not json */ }
      }
    } else {
      const text = await res.text().catch(() => '')
      rawPreview = text.slice(0, 4096)
      try { body = JSON.parse(text) } catch { /* not json */ }
    }
    return {status: res.status, contentType, body, rawPreview, headers, durationMs: Date.now() - start}
  } catch (err) {
    const message = err instanceof Error ? (err.name === 'AbortError' ? 'timed out' : err.message) : String(err)
    return {error: message, durationMs: Date.now() - start}
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

function rpcBody(method: string, params: unknown, id: number | string = 1): string {
  return JSON.stringify({jsonrpc: '2.0', id, method, params})
}

function initParams(protocolVersion: string): unknown {
  return {protocolVersion, capabilities: {}, clientInfo: {name: 'apprhythm-doctor', version: '0.1.0'}}
}

const RPC_HEADERS = {'content-type': 'application/json', accept: 'application/json, text/event-stream'}

export async function collectTransport(url: string, opts: CollectTransportOptions = {}): Promise<TransportProbes> {
  const t = opts.timeoutMs ?? 8000
  const post = (body: string, extra: Record<string, string> = {}) => http(url, {method: 'POST', headers: {...RPC_HEADERS, ...extra}, body, fetch: opts.fetch, timeoutMs: t})

  const probes: TransportProbes = {url}
  probes.initialize = await post(rpcBody('initialize', initParams(LATEST_PROTOCOL_VERSION)))
  probes.initializeOld = await post(rpcBody('initialize', initParams(OLD_PROTOCOL)))
  probes.get = await http(url, {method: 'GET', headers: {accept: 'text/event-stream'}, fetch: opts.fetch, timeoutMs: Math.min(t, 5000)})
  probes.options = await http(url, {
    method: 'OPTIONS',
    headers: {origin: 'https://chatgpt.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, mcp-session-id, mcp-protocol-version'},
    fetch: opts.fetch, timeoutMs: t,
  })
  probes.delete = await http(url, {method: 'DELETE', headers: {'mcp-session-id': 'apprhythm-doctor'}, fetch: opts.fetch, timeoutMs: t})
  probes.foreignOrigin = await post(rpcBody('initialize', initParams(LATEST_PROTOCOL_VERSION)), {origin: 'https://evil.example.com'})
  probes.malformedJson = await http(url, {method: 'POST', headers: RPC_HEADERS, body: '{"jsonrpc":"2.0","id":1,"method":', fetch: opts.fetch, timeoutMs: t})
  probes.unknownMethod = await post(rpcBody('apprhythm/does-not-exist', {}))
  probes.unknownTool = await post(rpcBody('tools/call', {name: 'apprhythm_no_such_tool_xyz', arguments: {}}))
  if (!opts.skipBigBody) {
    const big = JSON.stringify({jsonrpc: '2.0', id: 1, method: 'initialize', params: {...(initParams(LATEST_PROTOCOL_VERSION) as object), pad: 'x'.repeat(1_500_000)}})
    probes.bigBody = await post(big)
  }

  // Templates via raw tools/list + resources/read
  const list = await post(rpcBody('tools/list', {}))
  const tools = (list.body?.result as {tools?: Array<Record<string, unknown>>} | undefined)?.tools
  if (Array.isArray(tools)) {
    probes.toolCount = tools.length
    const uris = new Set<string>()
    for (const tool of tools) {
      const meta = (tool._meta ?? {}) as Record<string, unknown>
      const ui = (meta.ui ?? {}) as Record<string, unknown>
      const uri = (typeof ui.resourceUri === 'string' ? ui.resourceUri : typeof meta['openai/outputTemplate'] === 'string' ? meta['openai/outputTemplate'] : undefined) as string | undefined
      if (uri && uri.startsWith('ui://')) uris.add(uri)
    }
    probes.templates = []
    for (const uri of uris) {
      const read = await post(rpcBody('resources/read', {uri}))
      const contents = (read.body?.result as {contents?: Array<Record<string, unknown>>} | undefined)?.contents
      const first = contents?.[0]
      const entry: NonNullable<TransportProbes['templates']>[number] = {
        uri,
        status: read.status,
        mimeType: typeof first?.mimeType === 'string' ? (first.mimeType as string) : undefined,
        bytes: typeof first?.text === 'string' ? Buffer.byteLength(first.text as string) : undefined,
        error: read.error ?? (read.body?.error ? String(read.body.error.message) : undefined),
      }
      // Stale-digest check: replace a trailing digest with zeros and see if it still resolves
      const m = /^(.*[-_.])([0-9a-f]{6,})(\.[a-z0-9]+)$/i.exec(uri)
      if (m) {
        entry.staleUri = `${m[1]}${'0'.repeat(m[2].length)}${m[3]}`
        const stale = await post(rpcBody('resources/read', {uri: entry.staleUri}))
        const sc = (stale.body?.result as {contents?: unknown[]} | undefined)?.contents
        entry.staleResolves = Array.isArray(sc) && sc.length > 0
      }
      probes.templates.push(entry)
    }
  }

  if (opts.hammer && opts.hammer > 0) {
    const n = opts.hammer
    const results = await Promise.all(Array.from({length: n}, () => post(rpcBody('initialize', initParams(LATEST_PROTOCOL_VERSION)))))
    probes.hammer = {
      n,
      statuses: results.map((r) => r.status ?? 0),
      retryAfterSeen: results.some((r) => r.status === 429 && Boolean(r.headers?.['retry-after'])),
      errors: results.filter((r) => r.error).length,
    }
  }

  return opts.sanitize ? opts.sanitize(probes) : probes
}

// ---------------------------------------------------------------------------
// Findings (pure)
// ---------------------------------------------------------------------------

const LEAK_PATTERNS = [/\bat [\w.<>$]+ \((\/|[A-Za-z]:\\)/, /Traceback \(most recent call last\)/, /\.rb:\d+:in /, /\bNoMethodError\b|\bTypeError: Cannot read\b|\bNullPointerException\b/, /<pre[^>]*>[\s\S]*(Error|Exception)[\s\S]*<\/pre>/i]

function leaks(o: RpcOutcome | undefined): boolean {
  return Boolean(o?.rawPreview && LEAK_PATTERNS.some((re) => re.test(o.rawPreview!)))
}

export interface TransportFindingOptions {
  /** The URL is expected to be dark (404): everything should 404. */
  expectDark?: boolean
}

export function transportFindings(p: TransportProbes, opts: TransportFindingOptions = {}): Finding[] {
  const out: Finding[] = []
  const src = '§1'
  const F = (rule: string, severity: Finding['severity'], message: string, hint?: string, source = src): Finding => ({rule, severity, target: p.url, message, hint, source})

  if (opts.expectDark) {
    const statuses = [p.initialize, p.get, p.options, p.delete].map((o) => o?.status)
    const allDark = statuses.every((s) => s === 404)
    out.push(allDark
      ? F('transport/dark', 'pass', 'endpoint is dark (404 on POST/GET/OPTIONS/DELETE)')
      : F('transport/dark', 'fail', `endpoint is NOT dark: statuses ${statuses.join('/')} for POST/GET/OPTIONS/DELETE`, 'Turn the feature flag off (or you meant --no-expect-dark).'))
    return out
  }

  // initialize
  const init = p.initialize
  if (!init || init.error) {
    out.push(F('transport/initialize', 'fail', `POST initialize failed: ${init?.error ?? 'no response'}`, 'The MCP endpoint must accept JSON-RPC POST.'))
    return out // nothing else is meaningful
  }
  const result = init.body?.result as {serverInfo?: {name?: string}; capabilities?: unknown; instructions?: unknown; protocolVersion?: string} | undefined
  if (!init.status || init.status >= 400 || !result) {
    out.push(F('transport/initialize', 'fail', `POST initialize returned ${init.status ?? '?'}${init.body?.error ? ` (${init.body.error.message})` : ''}`, 'Expected a JSON-RPC result with serverInfo + capabilities.'))
  } else {
    if (!result.serverInfo?.name) out.push(F('transport/initialize', 'warn', 'initialize result has no serverInfo.name'))
    if (typeof result.instructions !== 'string' || result.instructions.trim().length === 0) {
      out.push(F('transport/initialize', 'warn', 'no server instructions in initialize', 'ChatGPT reads server-level instructions; return them from initialize.'))
    }
  }

  // protocol negotiation
  const oldRes = p.initializeOld?.body?.result as {protocolVersion?: string} | undefined
  if (p.initializeOld && (p.initializeOld.error || (p.initializeOld.status ?? 500) >= 400 || !oldRes)) {
    out.push(F('transport/protocol-version', 'warn', `initialize with an old protocolVersion (${OLD_PROTOCOL}) was rejected: ${p.initializeOld.error ?? p.initializeOld.status ?? p.initializeOld.body?.error?.message}`, 'Servers should negotiate down (respond with a version they support) rather than reject; older clients would fail to connect.'))
  } else if (result?.protocolVersion && oldRes?.protocolVersion && result.protocolVersion === oldRes.protocolVersion && result.protocolVersion !== OLD_PROTOCOL) {
    out.push(F('transport/protocol-version', 'info', `server pins protocolVersion ${result.protocolVersion} regardless of the client's request (fine if all clients support it)`))
  }

  // GET → SSE (also covered by transport/sse-get in validate; keep for doctor)
  const g = p.get
  if (g) {
    const ct = (g.contentType ?? '').toLowerCase()
    if (g.error) out.push(F('transport/sse-get', 'warn', `GET failed: ${g.error}`))
    else if (g.status === 405) out.push(F('transport/sse-get', 'fail', 'GET returns 405', "OpenAI's tool scanner fails the scan on 405. Answer GET with a text/event-stream response."))
    else if (!(g.status && g.status < 300 && ct.includes('text/event-stream'))) out.push(F('transport/sse-get', 'fail', `GET returns ${g.status} ${ct}; expected 2xx text/event-stream`))
  }

  // OPTIONS / CORS
  const o = p.options
  if (o && !o.error) {
    const allowHeaders = (o.headers?.['access-control-allow-headers'] ?? '').toLowerCase()
    const need = ['content-type', 'mcp-session-id', 'mcp-protocol-version']
    const missing = need.filter((h) => !allowHeaders.split(',').map((x) => x.trim()).includes(h) && allowHeaders !== '*')
    if (!o.status || o.status >= 400) {
      out.push(F('transport/cors', 'warn', `OPTIONS preflight returned ${o.status}`, 'Browser-based hosts preflight POST with custom headers; answer OPTIONS with 204 + Access-Control-Allow-* headers.'))
    } else if (missing.length > 0) {
      out.push(F('transport/cors', 'warn', `Access-Control-Allow-Headers is missing ${missing.join(', ')}`, 'Allow content-type, mcp-session-id and mcp-protocol-version.'))
    }
  }

  // DELETE
  const d = p.delete
  if (d && !d.error && d.status && d.status >= 500) {
    out.push(F('transport/delete', 'fail', `DELETE returned ${d.status}`, 'Return 405/404 for DELETE if you don\'t support session termination; never 5xx.'))
  }

  // Origin
  const fo = p.foreignOrigin
  if (fo && !fo.error && fo.status && fo.status < 300 && fo.body?.result) {
    out.push(F('transport/origin', 'warn', 'a request with Origin: https://evil.example.com was accepted', 'The MCP spec requires servers to validate Origin (DNS-rebinding). Allow-list chatgpt.com/your hosts and reject others.'))
  } else if (fo && !fo.error && fo.status && fo.status >= 400 && init.status && init.status < 300) {
    out.push(F('transport/origin', 'pass', 'foreign Origin rejected, no-Origin accepted'))
  }

  // Body bounds
  const b = p.bigBody
  if (b) {
    if (b.error) out.push(F('transport/body-bounds', 'fail', `1.5 MB body: ${b.error}`, 'Reject oversized bodies fast (413) instead of hanging/crashing.'))
    else if (b.status && b.status >= 500) out.push(F('transport/body-bounds', 'fail', `1.5 MB body → ${b.status}`, 'Bound the JSON-RPC body size and return 413/400.'))
    else if (b.status && b.status < 300) out.push(F('transport/body-bounds', 'warn', '1.5 MB body was accepted', 'Consider a bounded JSON-RPC body reader to limit resource exhaustion.'))
  }

  // Error hygiene
  const leaky = [['malformed JSON', p.malformedJson], ['unknown method', p.unknownMethod], ['unknown tool', p.unknownTool]] as const
  for (const [label, o2] of leaky) {
    if (!o2 || o2.error) continue
    if (leaks(o2)) out.push(F('transport/error-hygiene', 'fail', `${label} response looks like a stack trace / internal error dump`, 'Return JSON-RPC errors (-32700 / -32601 / isError) without stack traces or class names.', '§1, §8'))
    if (o2.status && o2.status >= 500) out.push(F('transport/error-hygiene', 'fail', `${label} → HTTP ${o2.status}`, 'Malformed input must not 5xx.'))
  }
  if (p.unknownMethod && !p.unknownMethod.error && !p.unknownMethod.body?.error && (p.unknownMethod.status ?? 0) < 400) {
    out.push(F('transport/error-hygiene', 'warn', 'unknown JSON-RPC method did not return an error', 'Respond with -32601 Method not found.'))
  }

  // Templates
  for (const t of p.templates ?? []) {
    if (t.error) out.push(F('transport/templates', 'fail', `resources/read ${t.uri} failed: ${t.error}`, undefined, '§3'))
    else {
      if (t.mimeType !== 'text/html;profile=mcp-app') out.push(F('transport/templates', 'fail', `${t.uri} mimeType is ${t.mimeType ?? 'missing'}; expected text/html;profile=mcp-app`, undefined, '§3'))
      if (!t.bytes) out.push(F('transport/templates', 'fail', `${t.uri} has no text body`, undefined, '§3'))
    }
    if (t.staleUri && t.staleResolves === false) {
      out.push(F('transport/templates', 'warn', `stale digest ${t.staleUri} does not resolve`, 'Keep previously published resource URIs resolvable with compatible content after redeploys. See docs/apps-sdk-contract.md §3.', '§3'))
    }
  }

  // Hammer
  if (p.hammer) {
    const fiveXX = p.hammer.statuses.filter((s) => s >= 500).length
    const has429 = p.hammer.statuses.includes(429)
    if (fiveXX > 0 || p.hammer.errors > 0) out.push(F('transport/rate-limit', 'fail', `${p.hammer.n} concurrent initialize → ${fiveXX} 5xx, ${p.hammer.errors} errors`, 'Rate limiting should answer 429, never 5xx/timeouts.'))
    else if (has429 && !p.hammer.retryAfterSeen) out.push(F('transport/rate-limit', 'warn', '429 returned without Retry-After', 'Add Retry-After so clients back off correctly.'))
    else if (!has429) out.push(F('transport/rate-limit', 'info', `no 429 at ${p.hammer.n} concurrent requests`, 'Raise --hammer or check the limit is enforced per authenticated account or IP.'))
  }

  return out
}
