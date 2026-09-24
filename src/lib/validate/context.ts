/**
 * Collect everything the rules need from a live MCP server.
 * Network happens here and only here; rules are pure functions over the context.
 */

import type {AppRhythmConfig} from '../config-schema.js'
import type {McpClient, RawResource} from '../mcp/client.js'
import {isUiUri, templateRefOf} from './meta.js'
import type {HttpProbe, ToolProbeResult, ValidationContext, ValidationProbes, WidgetTemplate} from './types.js'
import {acceptsEmptyArgs} from './rules/contract.js'
import {annotationsOf} from './meta.js'
import {collectTransport} from './transport.js'

export interface CollectOptions {
  client: McpClient
  serverUrl: string
  config?: AppRhythmConfig
  /** Run raw HTTP probes (SSE GET, well-known challenge). Default true. */
  probe?: boolean
  /** Override the challenge token from config (e.g. --challenge-token). */
  challengeToken?: string
  /** Timeout for each raw probe in ms. */
  probeTimeoutMs?: number
  /** Concurrent initialize requests for the rate-limit probe (0/undefined = skip). */
  hammer?: number
  /** Skip the 1.5 MB body probe. */
  skipBigBody?: boolean
  /**
   * Call every tool that accepts `{}` once (readOnlyHint tools twice) and keep the results
   * for contract/* runtime rules. Opt-in: it executes tools.
   */
  probeTools?: boolean
}

export const CHALLENGE_PATH = '/.well-known/openai-apps-challenge'

export async function collectContext(options: CollectOptions): Promise<ValidationContext> {
  const {client, serverUrl, config} = options
  const probe = options.probe ?? true

  const server = client.getServerInfo()
  const tools = await client.listToolsRaw()
  const resources = await client.listResourcesRaw()

  const templates = new Map<string, WidgetTemplate>()

  // Every ui:// URI referenced from a tool descriptor
  for (const tool of tools) {
    const {uri} = templateRefOf(tool)
    // Non-ui:// values (inline HTML, http URLs) are reported by tool/widget-template-ref, not fetched.
    if (!uri || !isUiUri(uri)) continue
    const entry = templates.get(uri) ?? {uri, referencedBy: []}
    entry.referencedBy.push(tool.name)
    templates.set(uri, entry)
  }

  // Every listed ui:// resource (may include templates no tool references yet)
  const listedByUri = new Map<string, RawResource>()
  for (const res of resources ?? []) {
    listedByUri.set(res.uri, res)
    if (isUiUri(res.uri) && !templates.has(res.uri)) {
      templates.set(res.uri, {uri: res.uri, referencedBy: []})
    }
  }

  for (const entry of templates.values()) {
    entry.listed = listedByUri.get(entry.uri)
    if (resources === null) {
      entry.readError = 'server does not advertise the resources capability'
      continue
    }

    try {
      entry.response = await client.readResourceEnvelope(entry.uri)
      entry.content = entry.response.contents[0]
      if (!entry.content) entry.readError = 'resources/read returned no contents'
    } catch (err) {
      entry.readError = err instanceof Error ? err.message : String(err)
    }
  }

  const probes: ValidationProbes = {}
  if (probe) {
    probes.sseGet = await httpProbe(serverUrl, {
      headers: {Accept: 'text/event-stream'},
      fetch: client.fetch?.bind(client),
      timeoutMs: options.probeTimeoutMs,
    })
    // Deep transport probes (raw HTTP; skip the templates part — validate reads them via the SDK)
    probes.transport = await collectTransport(serverUrl, {timeoutMs: options.probeTimeoutMs ?? 5000, hammer: options.hammer, skipBigBody: options.skipBigBody, fetch: client.fetch?.bind(client), sanitize: client.sanitize?.bind(client)})

    const token = options.challengeToken ?? config?.submission?.challenge_token
    if (token) {
      const host = config?.submission?.challenge_host ?? safeHost(serverUrl)
      if (host) {
        probes.challenge = await httpProbe(`https://${host}${CHALLENGE_PATH}`, {timeoutMs: options.probeTimeoutMs})
      }
    }
  }

  let probeResults: ToolProbeResult[] | undefined
  if (options.probeTools) {
    probeResults = []
    for (const tool of tools) {
      if (!acceptsEmptyArgs(tool as {inputSchema?: unknown})) continue
      const readOnly = annotationsOf(tool).readOnlyHint === true
      const entry: ToolProbeResult = {tool: tool.name, results: []}
      try {
        entry.results.push(await client.callTool(tool.name, {}, {meta: {'openai/subject': 'apprhythm-validate-probe', 'openai/session': 'apprhythm-validate-probe'}}))
        if (readOnly) entry.results.push(await client.callTool(tool.name, {}, {meta: {'openai/subject': 'apprhythm-validate-probe', 'openai/session': 'apprhythm-validate-probe'}}))
      } catch (err) {
        entry.error = err instanceof Error ? err.message : String(err)
      }
      probeResults.push(entry)
    }
  }

  if (client.sanitize) probes.sseGet = client.sanitize(probes.sseGet)
  return {serverUrl, server, probes, tools, resources, templates, config, ...(probeResults ? {probeResults} : {})}
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}

/**
 * Raw GET with a short timeout. Reads at most the first ~2 KB of the body so
 * an open SSE stream doesn't hang us; SSE probes are aborted right after headers.
 */
export async function httpProbe(
  url: string,
  opts: {headers?: Record<string, string>; timeoutMs?: number; fetch?: typeof fetch} = {},
): Promise<HttpProbe> {
  const start = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000)
  try {
    const res = await (opts.fetch ?? fetch)(url, {method: 'GET', headers: opts.headers, signal: controller.signal, redirect: 'follow'})
    const contentType = res.headers.get('content-type') ?? undefined
    let bodyPreview: string | undefined
    if (contentType && contentType.includes('text/event-stream')) {
      // Don't wait for a stream that may stay open; headers are what we needed.
      try {
        const reader = res.body?.getReader()
        if (reader) {
          const first = await Promise.race([reader.read(), new Promise<undefined>((r) => setTimeout(() => r(undefined), 300))])
          if (first && !first.done && first.value) bodyPreview = new TextDecoder().decode(first.value.subarray(0, 512)).trim()
          await reader.cancel().catch(() => {})
        }
      } catch {
        // ignore body errors on SSE probes
      }
    } else {
      const text = await res.text().catch(() => '')
      bodyPreview = text.slice(0, 2048).trim()
    }
    return {url, status: res.status, contentType, bodyPreview, durationMs: Date.now() - start}
  } catch (err) {
    const message = err instanceof Error ? (err.name === 'AbortError' ? 'timed out' : err.message) : String(err)
    return {url, error: message, durationMs: Date.now() - start}
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}
