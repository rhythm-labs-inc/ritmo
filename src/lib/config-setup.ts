import {loadConfig} from './config-loader.js'
import {authForServer} from './mcp/connection.js'
import type {McpAuthConfig} from './mcp/auth-schema.js'
import {readFile, writeFile} from 'node:fs/promises'
import {createInterface} from 'node:readline/promises'
import yaml from 'js-yaml'
import {apprhythmConfigSchema} from './config-schema.js'
import {McpClient} from './mcp/client.js'
import {McpError} from './mcp/errors.js'
import {displayText} from './cli/builder-experience.js'
import {terminalColor, terminalMuted} from './cli/ritmo-terminal.js'

export const DEFAULT_SERVER_URL = 'http://localhost:2091/mcp'

/** Endpoint setup uses references from matching configuration; never retarget credentials. */
export function validateServerUrl(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new McpError('args', 'Invalid MCP URL.', 'Enter an absolute http:// or https:// Streamable HTTP endpoint.') }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || /\s/.test(value)) throw new McpError('args', 'Invalid MCP URL.', 'Use an absolute HTTP or HTTPS endpoint without whitespace.')
  if (url.username || url.password || url.hash || [...url.searchParams.keys()].some((key) => /token|key|auth|secret|password|signature|credential/i.test(key))) {
    throw new McpError('args', 'Credentials and fragments are not supported in MCP setup URLs.', 'Use an endpoint without embedded secrets. Configure MCP OAuth or header references with `ritmo auth mcp`.')
  }
  return value
}

export async function checkServerUrl(value: string): Promise<string[]> {
  const config = await loadConfig().catch(() => undefined)
  const client = new McpClient({serverUrl: validateServerUrl(value), timeoutMs: 5000, auth: authForServer(config, value)})
  try {
    await client.connect()
    return (await client.listTools()).map((tool) => tool.name)
  } catch {
    // Transport errors can echo URLs or server bodies. Setup reports no raw transport data.
    throw new McpError('connection', 'MCP connection not verified.', 'Check the endpoint and server availability. If access is required, configure it with ritmo auth mcp and retry. Retry or explicitly save for later with --skip-check.')
  } finally { await client.close().catch(() => {}) }
}

interface SetupOptions {
  url?: string
  skipCheck?: boolean
  ask?: (prompt: string) => Promise<string>
  askChoice?: (prompt: string) => Promise<string>
  report: (message: string) => void
  check?: (url: string) => Promise<string[]>
}

export async function chooseServerUrl({url, skipCheck, ask, askChoice, report, check = checkServerUrl}: SetupOptions): Promise<string> {
  if (!ask && !url) {
    report('Using the local starter endpoint. Connection not checked; set it with `ritmo config set server.url <url>`.')
    return DEFAULT_SERVER_URL
  }
  let candidate = url
  for (;;) {
    candidate ??= (await ask!('\n  Enter your MCP server URL (do not provide credentials): ')).trim()
    try { validateServerUrl(candidate) } catch (error) {
      if (!ask) throw error
      report(error instanceof McpError ? `${error.message} ${error.hint ?? ''}` : 'Invalid URL.')
      candidate = undefined
      continue
    }
    if (skipCheck) { report('Connection not checked. Saving endpoint for later.'); return candidate }
    try {
      const names = await check(candidate)
      report('')
      report(`  ✓ Connected — ${names.length} ${names.length === 1 ? 'tool' : 'tools'} found.`)
      if (names.length) report('')
      for (const name of names) report(terminalMuted(`    ${displayText(name)}`))
      if (!names.length) report('This server currently exposes no tools. Check the endpoint if you expected tools.')
    } catch {
      if (!ask) throw new McpError('connection', 'MCP connection not verified.', 'Check the URL, server availability or access requirements. Retry, or use --skip-check to explicitly save for later.')
      report('MCP connection not verified. Check the URL, server availability or access requirements. Configure access with ritmo auth mcp if needed.')
      const action = (await ask('Type retry to enter another URL, save to save for later, or cancel: ')).trim().toLowerCase()
      if (action === 'save') return candidate
      if (action === 'retry') { candidate = undefined; continue }
      throw new McpError('args', 'Setup cancelled. Configuration was not changed.')
    }
    if (!ask) return candidate
    const confirm = (await (askChoice ?? ask)(formatSetupConfirmation())).trim().toLowerCase()
    if (confirm === 'y' || confirm === 'yes') return candidate
    if (confirm === 'n' || confirm === 'retry') { candidate = undefined; continue }
    throw new McpError('args', 'Setup cancelled. Configuration was not changed.')
  }
}

/** Brand accents identify available actions, not completed checks. */
export function formatSetupConfirmation(): string {
  const key = (value: string) => terminalColor('#4FBF95', value)
  return `\n  Look right?\n\n    - Type ${key('Y')} to Continue\n    - Type ${key('N')} to Change the url\n    - Type ${key('C')} to Cancel\n\n  `
}

/** Read one deliberate Y/N/C key and always restore the terminal mode. */
export async function readSetupChoice(prompt: string, input = process.stdin, output = process.stdout): Promise<string> {
  output.write(prompt)
  const wasRaw = Boolean(input.isRaw)
  // Fresh stdin is neither paused nor flowing. Resume only while reading the
  // choice; leaving that new read active would keep the CLI process alive.
  const wasFlowing = input.readableFlowing === true
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      input.removeListener('data', onData)
      input.removeListener('end', onEnd)
      input.removeListener('error', onError)
      input.setRawMode(wasRaw)
      if (!wasFlowing) input.pause()
    }
    const onError = (error: Error) => { cleanup(); reject(error) }
    const onEnd = () => onError(new McpError('args', 'Setup cancelled. Configuration was not changed.'))
    const onData = (data: Buffer | string) => {
      const key = data.toString()
      if (key === '\u0003' || key === '\u0004') { onEnd(); return }
      // Ignore escape sequences, pasted strings and unrelated keys.
      if (!/^[ync]$/i.test(key)) return
      cleanup()
      output.write(`${key.toUpperCase()}\n`)
      resolve(key.toLowerCase())
    }
    input.on('data', onData)
    input.once('end', onEnd)
    input.once('error', onError)
    input.setRawMode(true)
    input.resume()
  })
}

export async function promptServerUrl(options: Omit<SetupOptions, 'ask' | 'askChoice'> & {interactive: boolean}): Promise<string> {
  if (!options.interactive) return chooseServerUrl(options)
  const ask = async (prompt: string) => {
    const rl = createInterface({input: process.stdin, output: process.stdout})
    const controller = new AbortController()
    const cancel = () => controller.abort()
    rl.on('close', cancel)
    rl.on('SIGINT', cancel)
    try { return await rl.question(prompt, {signal: controller.signal}) }
    catch (error) {
      if (controller.signal.aborted) throw new McpError('args', 'Setup cancelled. Configuration was not changed.')
      throw error
    } finally { rl.close() }
  }
  return chooseServerUrl({...options, ask, askChoice: process.stdin.isTTY && typeof process.stdin.setRawMode === 'function' ? readSetupChoice : ask})
}

export function updateServerUrlText(raw: string, url: string): string {
  validateServerUrl(url)
  let parsed: unknown
  try { parsed = yaml.load(raw) } catch { throw new McpError('args', 'Could not parse the selected configuration.', 'Repair the YAML before editing server.url.') }
  const result = apprhythmConfigSchema.safeParse(parsed)
  if (!result.success) throw new McpError('args', 'Invalid selected configuration.', 'Run `ritmo config show` for configuration diagnostics.')
  const document = parsed as {server: {url: string; auth?: McpAuthConfig}}
  if (new URL(document.server.url).href !== new URL(url).href) delete document.server.auth
  document.server.url = url
  // Preserve comments and formatting for the ordinary block form. Verify the
  // candidate against the full parsed document before using this textual edit.
  const block = /(^server:[ \t]*(?:#[^\n]*)?\r?\n)((?:[ \t]+[^\n]*\n|[ \t]*\n)*)/m
  const patched = raw.replace(block, (whole, header: string, body: string) => {
    if (!/^[ \t]+url:[ \t]*[^\n]*$/m.test(body)) return whole
    return header + body.replace(/^([ \t]+url:)[ \t]*[^\n]*$/m, `$1 ${JSON.stringify(url)}`)
  })
  try { if (JSON.stringify(yaml.load(patched)) === JSON.stringify(document)) return patched } catch { /* Fall back to serialization for flow/alias forms. */ }
  return yaml.dump(document, {lineWidth: -1, noRefs: true})
}

export async function saveServerUrl(file: string, original: string, url: string): Promise<void> {
  const updated = updateServerUrlText(original, url)
  if (await readFile(file, 'utf8') !== original) throw new McpError('args', 'Configuration changed during setup.', 'Retry against the current file.')
  await writeFile(file, updated, 'utf8')
}
