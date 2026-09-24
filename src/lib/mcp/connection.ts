import {getCredential} from '../credentials/store.js'
import {keychainDisabled} from '../credentials/resolution.js'
import {McpError} from './errors.js'
import {mcpAuthSchema, type McpAuthConfig, type SecretReference} from './auth-schema.js'
import {McpOAuthProvider, type OAuthOptions} from './oauth.js'

/** Auth is scoped to the complete endpoint, including its path and query. */
export function authForServer(config: {server?: {url?: string; auth?: McpAuthConfig}} | undefined, serverUrl: string): McpAuthConfig | undefined {
  return config?.server?.url && new URL(config.server.url).href === new URL(serverUrl).href ? config.server.auth : undefined
}

export function authenticationError(message = 'MCP authentication is required.'): McpError {
  return new McpError('authentication', message, 'Check server.auth in ritmo.yaml and its secret references. For OAuth, run `ritmo auth mcp --login`; use --clear to forget a saved connection.')
}

export function secureAuthUrl(value: string | URL): URL {
  const url = new URL(value)
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw authenticationError('Authentication requires HTTPS (HTTP is allowed only for loopback fixtures). Do not embed credentials or fragments in URLs.')
  }
  return url
}

export async function resolveSecret(ref: SecretReference): Promise<string> {
  let value: string | null | undefined
  if ('env' in ref) value = process.env[ref.env]
  else if ('keychain' in ref && !keychainDisabled()) value = await getCredential(ref.keychain)
  if (!value?.trim()) throw authenticationError('A configured MCP secret reference is missing or unavailable.')
  value = (ref.prefix ?? '') + value.trim()
  if (/[\r\n\0]/.test(value)) throw authenticationError('A configured MCP secret contains invalid control characters.')
  return value
}

export async function createConnection(serverUrl: string, input?: McpAuthConfig, oauthOptions?: OAuthOptions): Promise<McpConnection> {
  const parsed = mcpAuthSchema.safeParse(input ?? {})
  if (!parsed.success) throw authenticationError('Invalid MCP authentication configuration. Header names must be unique and OAuth cannot be combined with a custom Authorization header.')
  if (input) {
    const endpoint = secureAuthUrl(serverUrl)
    if ([...endpoint.searchParams.keys()].some((key) => /token|key|auth|secret|password|signature|credential/i.test(key))) throw authenticationError('Use secret references instead of credentials in the MCP URL.')
  }
  const headers = new Headers()
  for (const [name, ref] of Object.entries(parsed.data.headers ?? {})) headers.set(name, await resolveSecret(ref))
  const oauth = parsed.data.oauth ? await McpOAuthProvider.create(serverUrl, parsed.data.oauth, oauthOptions) : undefined
  return new McpConnection(serverUrl, headers, oauth)
}

export class McpConnection {
  constructor(readonly serverUrl: string, private readonly headers: Headers, readonly oauth?: McpOAuthProvider) {}

  /** Custom headers are injected only here, never in SDK requestInit (which also reaches discovery). */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.href !== new URL(this.serverUrl).href) {
      if (!this.oauth) throw authenticationError('Refusing to send an authenticated request outside the configured MCP endpoint.')
      return this.oauth.fetch(input, init)
    }
    await this.oauth?.ensureFresh()
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value))
    this.headers.forEach((value, name) => headers.set(name, value))
    if (this.oauth) {
      const tokens = await this.oauth.tokens()
      if (tokens) headers.set('authorization', `Bearer ${tokens.access_token}`)
    }
    const response = await fetch(input, {...init, headers, redirect: 'manual'})
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      throw authenticationError('The MCP endpoint redirected. Configure its final URL explicitly before reconnecting.')
    }
    if ((response.status === 401 || response.status === 403) && !this.oauth) {
      await response.body?.cancel()
      throw authenticationError('The MCP endpoint rejected or requires credentials.')
    }
    if (response.status === 401) this.oauth?.observeChallenge(response)
    return response
  }

  redact(value: string): string {
    let safe = this.oauth?.redact(value) ?? value
    this.headers.forEach((secret) => {
      for (const value of [secret, secret.replace(/^Bearer /i, '')]) {
        if (value) safe = safe.split(value).join('[redacted]').split(encodeURIComponent(value)).join('[redacted]')
      }
    })
    return safe
  }
}
