import {createHash, randomBytes, timingSafeEqual} from 'node:crypto'
import {createServer} from 'node:http'
import {auth, extractWWWAuthenticateParams, type OAuthClientProvider} from '@modelcontextprotocol/sdk/client/auth.js'
import {OAuthTokensSchema, type OAuthTokens, type OAuthClientInformationMixed} from '@modelcontextprotocol/sdk/shared/auth.js'
import {getCredential, setCredential, deleteCredential} from '../credentials/store.js'
import {keychainDisabled} from '../credentials/resolution.js'
import type {McpAuthConfig} from './auth-schema.js'
import {authenticationError, resolveSecret, secureAuthUrl} from './connection.js'

type OAuthConfig = NonNullable<McpAuthConfig['oauth']>
interface SavedSession {
  issuer?: string
  client?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  expiresAt?: number
}
export interface OAuthStore {
  read(key: string): Promise<string | null>
  write(key: string, value: string): Promise<void>
  remove(key: string): Promise<unknown>
}
export interface OAuthOptions {
  store?: OAuthStore
  now?: () => number
}

const keychain: OAuthStore = {
  read: (key) => keychainDisabled() ? Promise.resolve(null) : getCredential(key),
  async write(key, value) {
    if (keychainDisabled()) throw authenticationError('OAuth persistence requires the OS keychain. For CI, use an environment-backed Authorization header.')
    await setCredential(key, value)
  },
  remove: (key) => keychainDisabled() ? Promise.resolve(false) : deleteCredential(key),
}

/** Protocol behavior delegates to the SDK; local policy is documented in apps-sdk-contract.md §2. */
export class McpOAuthProvider implements OAuthClientProvider {
  private saved: SavedSession = {}
  private verifier?: string
  private stateValue = ''
  private authorize?: (url: URL) => Promise<void>
  private readonly secretValues = new Set<string>()
  private readonly store: OAuthStore
  private readonly now: () => number
  private metadataUrls = new Set<string>()
  private authorizationEndpoints = new Set<string>()
  private tokenEndpoints = new Set<string>()
  private exchangeEndpoints = new Set<string>()
  private refresh?: Promise<void>
  private clientSecret?: string
  readonly storageKey: string
  readonly redirectUrl: string
  readonly addClientAuthentication?: OAuthClientProvider['addClientAuthentication']

  private constructor(readonly serverUrl: string, private readonly config: OAuthConfig, options: OAuthOptions) {
    this.store = options.store ?? keychain
    this.now = options.now ?? Date.now
    // Use the SDK's hook so an explicit registration method also works with
    // older supported SDK releases. No retry or issuer-specific override.
    // See docs/apps-sdk-contract.md §2, MCP connection authorization.
    if (config.token_endpoint_auth_method) this.addClientAuthentication = async (headers, params) => {
      if (!config.client_id || !this.clientSecret) throw authenticationError('token_endpoint_auth_method requires a client ID and client-secret reference.')
      if (config.token_endpoint_auth_method === 'client_secret_post') {
        params.set('client_id', config.client_id)
        params.set('client_secret', this.clientSecret)
      } else {
        const encoded = (value: string) => new URLSearchParams({value}).toString().slice('value='.length)
        const credential = Buffer.from(`${encoded(config.client_id)}:${encoded(this.clientSecret)}`).toString('base64')
        this.secretValues.add(credential)
        headers.set('authorization', `Basic ${credential}`)
      }
    }
    this.redirectUrl = `http://127.0.0.1:${config.callback_port ?? 49178}/callback`
    this.storageKey = `mcp-oauth:${createHash('sha256').update(JSON.stringify([new URL(serverUrl).href, config.account ?? 'default', config.client_id ?? null, this.redirectUrl, config.scope ?? null])).digest('hex')}`
    const endpoint = secureAuthUrl(serverUrl)
    this.metadataUrls.add(new URL(`/.well-known/oauth-protected-resource${endpoint.pathname === '/' ? '' : endpoint.pathname}`, endpoint).href)
    this.metadataUrls.add(new URL('/.well-known/oauth-protected-resource', endpoint).href)
  }

  static async clearSession(serverUrl: string, config: OAuthConfig, options: OAuthOptions = {}): Promise<void> {
    await new McpOAuthProvider(serverUrl, config, options).clear()
  }

  static async create(serverUrl: string, config: OAuthConfig, options: OAuthOptions = {}): Promise<McpOAuthProvider> {
    const provider = new McpOAuthProvider(serverUrl, config, options)
    try {
      const raw = await provider.store.read(provider.storageKey)
      if (raw) {
        const parsed = JSON.parse(raw) as SavedSession
        if (!parsed || typeof parsed !== 'object' || (parsed.issuer && typeof parsed.issuer !== 'string') || (parsed.expiresAt !== undefined && !Number.isFinite(parsed.expiresAt))) throw new Error()
        if (parsed.tokens) parsed.tokens = OAuthTokensSchema.parse(parsed.tokens)
        provider.saved = parsed
      }
      if (config.client_secret) provider.clientSecret = await resolveSecret(config.client_secret)
      provider.rememberSecrets()
      return provider
    } catch { throw authenticationError('Could not read the MCP OAuth session or client credential. Check keychain access, or clear the saved session and reconnect.') }
  }

  get clientMetadata() {
    return {
      client_name: 'Ritmo', redirect_uris: [this.redirectUrl], grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], token_endpoint_auth_method: this.config.token_endpoint_auth_method ?? (this.clientSecret ? 'client_secret_basic' : 'none'),
      ...(this.config.scope ? {scope: this.config.scope} : {}),
    }
  }
  state(): string { this.stateValue = randomBytes(32).toString('hex'); return this.stateValue }
  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.config.client_id ? {client_id: this.config.client_id, ...(this.clientSecret ? {client_secret: this.clientSecret} : {}), ...(this.config.token_endpoint_auth_method ? {token_endpoint_auth_method: this.config.token_endpoint_auth_method} : {})} : this.saved.client
  }
  async saveClientInformation(client: OAuthClientInformationMixed): Promise<void> { this.saved.client = client; await this.persist() }
  tokens(): OAuthTokens | undefined { return this.saved.tokens }
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const previousRefresh = this.saved.tokens?.refresh_token
    this.saved.tokens = {...tokens, ...(tokens.refresh_token ? {} : previousRefresh ? {refresh_token: previousRefresh} : {})}
    this.saved.expiresAt = tokens.expires_in === undefined ? undefined : this.now() + tokens.expires_in * 1000
    await this.persist()
  }
  async redirectToAuthorization(url: URL): Promise<void> {
    secureAuthUrl(url)
    const base = new URL(url); base.search = ''
    if (!this.authorizationEndpoints.has(base.href)) throw authenticationError('The authorization URL is not advertised by the bound issuer.')
    if (!this.authorize) throw authenticationError()
    await this.authorize(url)
  }
  saveCodeVerifier(value: string): void { this.verifier = value; this.secretValues.add(value) }
  codeVerifier(): string {
    if (!this.verifier) throw authenticationError('The authorization attempt expired. Start login again.')
    return this.verifier
  }
  async validateResourceURL(serverUrl: string | URL, resource?: string): Promise<URL> {
    if (!this.saved.issuer || !resource || new URL(resource).href !== new URL(serverUrl).href) throw authenticationError('OAuth discovery must identify this exact MCP resource and its authorization server.')
    return new URL(resource)
  }
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier'): Promise<void> {
    if (scope === 'all' || scope === 'client') delete this.saved.client
    if (scope === 'all' || scope === 'tokens') { delete this.saved.tokens; delete this.saved.expiresAt }
    if (scope === 'all' || scope === 'verifier') this.verifier = undefined
    await this.persist()
  }
  async clear(): Promise<void> { await this.store.remove(this.storageKey); this.saved = {}; this.verifier = undefined }
  status(): {mode: 'oauth'; status: 'connected' | 'expired' | 'disconnected'; account: string; refreshAvailable: boolean} {
    return {mode: 'oauth', status: !this.saved.tokens ? 'disconnected' : this.saved.expiresAt !== undefined && this.saved.expiresAt <= this.now() ? 'expired' : 'connected', account: this.config.account ?? 'default', refreshAvailable: Boolean(this.saved.tokens?.refresh_token)}
  }
  async ensureFresh(): Promise<void> {
    if (!this.saved.tokens || this.saved.expiresAt === undefined || this.saved.expiresAt > this.now() + 30_000) return
    this.refresh ??= this.refreshTokens().finally(() => { this.refresh = undefined })
    return this.refresh
  }
  private async refreshTokens(): Promise<void> {
    try { await auth(this, {serverUrl: this.serverUrl, fetchFn: this.fetch}) }
    catch { throw authenticationError('The MCP OAuth session expired or could not refresh. Reconnect to continue.') }
  }

  observeChallenge(response: Response): void {
    const metadata = extractWWWAuthenticateParams(response).resourceMetadataUrl
    if (metadata) this.metadataUrls.add(secureAuthUrl(metadata).href)
  }

  /** Discovery has no MCP headers; token/client secrets go only to endpoints advertised by the bound issuer. */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = secureAuthUrl(input instanceof Request ? input.url : String(input))
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const issuer = this.saved.issuer ? new URL(this.saved.issuer) : undefined
    const discovery = method === 'GET'
    const issuerDiscovery = issuer && url.origin === issuer.origin && url.pathname.includes('/.well-known/')
    if (discovery ? !this.metadataUrls.has(url.href) && !issuerDiscovery : method !== 'POST' || !this.tokenEndpoints.has(url.href)) {
      throw authenticationError('OAuth attempted an endpoint outside the discovered resource and issuer.')
    }
    const headers = new Headers(init?.headers)
    if (discovery) headers.delete('authorization')
    const response = await fetch(input, {...init, headers, redirect: 'manual', signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000)})
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw authenticationError('OAuth endpoint redirects are unsupported; configure the final endpoint or contact its owner.') }
    // Some issuers return OAuth errors with HTTP 200; the SDK expects token JSON.
    // Only fixed messages leave this boundary. See docs/apps-sdk-contract.md §2.
    if (response.ok && !discovery && this.exchangeEndpoints.has(url.href)) {
      let errorCode: unknown
      try { errorCode = (await response.clone().json() as {error?: unknown})?.error } catch { /* SDK handles malformed token responses. */ }
      if (errorCode !== undefined) {
        await response.body?.cancel()
        throw authenticationError(errorCode === 'incorrect_client_credentials' || errorCode === 'invalid_client'
          ? 'The OAuth server rejected the client credentials. Check client_id, the client-secret reference, and token_endpoint_auth_method against the app registration.'
          : 'The OAuth server rejected the token exchange. Start sign-in again and check the app registration.')
      }
    }
    if (response.ok && discovery) {
      const doc = await response.clone().json() as Record<string, unknown>
      if (this.metadataUrls.has(url.href)) {
        if (typeof doc.resource !== 'string' || new URL(doc.resource).href !== new URL(this.serverUrl).href || !Array.isArray(doc.authorization_servers) || typeof doc.authorization_servers[0] !== 'string') throw authenticationError('Invalid protected-resource metadata.')
        const nextIssuer = secureAuthUrl(doc.authorization_servers[0]).href
        if (this.saved.issuer && this.saved.issuer !== nextIssuer) throw authenticationError('The MCP authorization server changed. Clear the saved connection before authorizing the new issuer.')
        this.saved.issuer = nextIssuer
      } else {
        if (typeof doc.issuer !== 'string' || secureAuthUrl(doc.issuer).href !== this.saved.issuer) throw authenticationError('OAuth metadata issuer does not match the resource authorization server.')
        // Explicit pre-registration hints must not silently fall back to another
        // advertised method. An omitted list still permits a registration hint.
        if (this.config.token_endpoint_auth_method && Array.isArray(doc.token_endpoint_auth_methods_supported) && !doc.token_endpoint_auth_methods_supported.includes(this.config.token_endpoint_auth_method)) {
          throw authenticationError('The configured token_endpoint_auth_method conflicts with the authorization server metadata. Check the app registration and supported methods.')
        }
        for (const name of ['token_endpoint', 'registration_endpoint']) {
          if (typeof doc[name] === 'string') this.tokenEndpoints.add(secureAuthUrl(doc[name] as string).href)
        }
        if (typeof doc.token_endpoint === 'string') this.exchangeEndpoints.add(secureAuthUrl(doc.token_endpoint).href)
        if (typeof doc.authorization_endpoint === 'string') {
          const endpoint = secureAuthUrl(doc.authorization_endpoint); endpoint.search = ''
          this.authorizationEndpoints.add(endpoint.href)
        }
        if (!this.clientInformation() && !doc.registration_endpoint) throw authenticationError('This server does not advertise dynamic registration. Configure a pre-registered OAuth client_id.')
      }
    }
    return response
  }

  async login(options: {openUrl?: (url: URL) => Promise<void>; onProgress?: (phase: 'waiting' | 'completing') => void; timeoutMs?: number; signal?: AbortSignal; request?: typeof fetch} = {}): Promise<void> {
    const callbackUrl = new URL(this.redirectUrl)
    let accept!: (code: string) => void
    let decline!: (error: Error) => void
    const code = new Promise<string>((resolve, reject) => { accept = resolve; decline = reject })
    // Callback may arrive while the browser opener is still returning.
    void code.catch(() => {})
    const callback = createServer((req, res) => {
      const incoming = new URL(req.url ?? '/', this.redirectUrl)
      const state = incoming.searchParams.get('state') ?? ''
      if (req.method !== 'GET' || incoming.pathname !== callbackUrl.pathname || !this.stateValue || !/^[a-f0-9]{64}$/.test(state) || !timingSafeEqual(Buffer.from(state), Buffer.from(this.stateValue))) {
        res.writeHead(400, {'content-type': 'text/plain'}).end('Invalid authorization callback.'); return
      }
      res.setHeader('cache-control', 'no-store')
      res.setHeader('content-type', 'text/plain')
      if (incoming.searchParams.has('error') || !incoming.searchParams.get('code')) {
        res.writeHead(400).end('Authorization was declined. Return to Ritmo.'); decline(authenticationError('MCP authorization was declined or cancelled.')); return
      }
      res.end('Authorization received. Ritmo still needs to exchange and securely save your login. Return to Ritmo for sign-in confirmation. You can close this tab.')
      accept(incoming.searchParams.get('code')!)
    })
    const timeout = setTimeout(() => decline(authenticationError('MCP authorization timed out. Start login again.')), options.timeoutMs ?? 120_000)
    const aborted = () => decline(authenticationError('MCP authorization was cancelled.'))
    options.signal?.addEventListener('abort', aborted, {once: true})
    try {
      if (options.signal?.aborted) throw authenticationError('MCP authorization was cancelled.')
      await new Promise<void>((resolve, reject) => { callback.once('error', reject); callback.listen(Number(callbackUrl.port), '127.0.0.1', resolve) })
      const openUrl = options.openUrl ?? (async (url: URL) => { const {default: open} = await import('open'); await open(url.href) })
      this.authorize = async (url) => { options.onProgress?.('waiting'); await openUrl(url) }
      await this.invalidateCredentials('tokens')
      const challenge = await (options.request ?? fetch)(this.serverUrl, {headers: {accept: 'application/json, text/event-stream'}, redirect: 'manual', signal: AbortSignal.timeout(10_000)})
      const params = extractWWWAuthenticateParams(challenge)
      await challenge.body?.cancel()
      if (params.resourceMetadataUrl) this.metadataUrls.add(secureAuthUrl(params.resourceMetadataUrl).href)
      const args = {serverUrl: this.serverUrl, fetchFn: this.fetch, resourceMetadataUrl: params.resourceMetadataUrl, scope: params.scope}
      if (await auth(this, args) === 'REDIRECT') {
        const authorizationCode = await code
        this.secretValues.add(authorizationCode)
        options.onProgress?.('completing')
        await auth(this, {...args, authorizationCode})
      }
    } catch (error) {
      // Never echo OAuth server bodies, callback parameters, or library errors.
      if (error instanceof Error && error.name === 'McpError') throw error
      throw authenticationError('MCP OAuth login failed. Check client registration, callback port, and server authorization support.')
    } finally {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', aborted)
      this.authorize = undefined; this.verifier = undefined; this.stateValue = ''
      callback.closeAllConnections()
      if (callback.listening) await new Promise<void>((resolve) => callback.close(() => resolve()))
    }
  }

  redact(value: string): string {
    for (const secret of this.secretValues) if (secret) value = value.split(secret).join('[redacted]')
    return value
  }
  private rememberSecrets(): void {
    for (const secret of [this.saved.tokens?.access_token, this.saved.tokens?.refresh_token, this.saved.client?.client_secret, this.clientSecret]) if (secret) this.secretValues.add(secret)
  }
  private async persist(): Promise<void> {
    this.rememberSecrets()
    try { await this.store.write(this.storageKey, JSON.stringify(this.saved)) }
    catch { throw authenticationError('Could not securely store the MCP OAuth session. Check OS keychain access; no plaintext fallback is used.') }
  }
}
