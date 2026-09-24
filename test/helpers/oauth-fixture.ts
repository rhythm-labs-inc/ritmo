import {createHash, randomBytes} from 'node:crypto'
import type {OAuthStore} from '../../src/lib/mcp/oauth.js'
import {startFixtureServer} from './fixture-server.js'

export function memoryOAuthStore(): OAuthStore {
  const values = new Map<string, string>()
  return {
    async read(key) { return values.get(key) ?? null },
    async write(key, value) { values.set(key, value) },
    async remove(key) { values.delete(key) },
  }
}

export async function oauthFixture(options: {registration?: boolean; denied?: boolean; invalidState?: boolean; rejectTokens?: boolean; clientAuth?: {method: 'client_secret_basic' | 'client_secret_post'; advertised: boolean; id: string; secret: string}; clientError?: string} = {}) {
  let origin = ''
  let resource = ''
  let accessToken = ''
  let refreshToken = ''
  let challenge = ''
  let redirect = ''
  let authorizationCode = ''
  let issuerOverride: string | undefined
  let rejectRefresh = false
  const requests: Array<{url: string; headers: Record<string, unknown>; body: string}> = []
  const fixture = await startFixtureServer({
    tools: [{name: 'echo', inputSchema: {type: 'object'}}],
    resources: [{uri: 'ui://oauth-fixture.html', text: '<p>Authenticated fixture</p>'}],
    async onHttp(req, res) {
      const url = new URL(req.url ?? '/', origin)
      const json = (status: number, value: unknown) => { res.writeHead(status, {'content-type': 'application/json'}).end(JSON.stringify(value)); return true }
      if (url.pathname === '/mcp') {
        if (accessToken && req.headers.authorization === `Bearer ${accessToken}`) return false
        res.setHeader('www-authenticate', `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="read"`)
        return json(401, {error: 'unauthorized'})
      }
      let body = ''
      for await (const chunk of req) body += String(chunk)
      requests.push({url: url.pathname, headers: {...req.headers}, body})
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return json(200, {resource, authorization_servers: [issuerOverride ?? origin], scopes_supported: ['read']})
      if (url.pathname === '/.well-known/oauth-authorization-server') return json(200, {
        issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
        ...(options.registration === false ? {} : {registration_endpoint: `${origin}/register`}),
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
        ...(options.clientAuth ? options.clientAuth.advertised ? {token_endpoint_auth_methods_supported: [options.clientAuth.method]} : {} : {token_endpoint_auth_methods_supported: ['none', 'client_secret_basic']}), code_challenge_methods_supported: ['S256'],
      })
      if (url.pathname === '/register') return json(201, {...JSON.parse(body), client_id: 'fixture-client'})
      if (url.pathname === '/authorize') {
        challenge = url.searchParams.get('code_challenge') ?? ''
        redirect = url.searchParams.get('redirect_uri') ?? ''
        if (url.searchParams.get('code_challenge_method') !== 'S256' || url.searchParams.get('resource') !== resource) return json(400, {error: 'invalid_request'})
        const callback = new URL(redirect)
        callback.searchParams.set('state', options.invalidState ? 'invalid' : url.searchParams.get('state') ?? '')
        if (options.denied) callback.searchParams.set('error', 'access_denied')
        else { authorizationCode = randomBytes(16).toString('hex'); callback.searchParams.set('code', authorizationCode) }
        res.writeHead(302, {location: callback.href}).end(); return true
      }
      if (url.pathname === '/token') {
        if (options.rejectTokens) return json(400, {error: 'invalid_grant'})
        const params = new URLSearchParams(body)
        if (options.clientError) return json(200, {error: options.clientError, error_description: 'private server detail fixture-secret', access_token: 'fixture-secret', token_type: 'Bearer', expires_in: 60})
        if (options.clientAuth) {
          const {method, id, secret} = options.clientAuth
          const authenticated = method === 'client_secret_basic'
            ? req.headers.authorization === `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` && !params.has('client_secret')
            : !req.headers.authorization && params.get('client_id') === id && params.get('client_secret') === secret
          if (!authenticated) return json(200, {error: 'incorrect_client_credentials', error_description: 'private server detail fixture-secret'})
        }
        if (params.get('resource') !== resource) return json(400, {error: 'invalid_target'})
        if (params.get('grant_type') === 'refresh_token') {
          if (rejectRefresh || params.get('refresh_token') !== refreshToken) return json(400, {error: 'invalid_grant'})
        } else {
          if (!authorizationCode || params.get('code') !== authorizationCode || params.get('redirect_uri') !== redirect || createHash('sha256').update(params.get('code_verifier') ?? '').digest('base64url') !== challenge) return json(400, {error: 'invalid_grant'})
          authorizationCode = ''
        }
        accessToken = `fixture-access-${randomBytes(8).toString('hex')}`
        refreshToken = `fixture-refresh-${randomBytes(8).toString('hex')}`
        return json(200, {access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer', expires_in: 60, scope: 'read'})
      }
      return json(404, {error: 'not_found'})
    },
  })
  resource = fixture.url; origin = new URL(resource).origin
  return {
    ...fixture, requests,
    get accessToken() { return accessToken },
    setIssuer(value: string) { issuerOverride = value },
    rejectRefresh() { rejectRefresh = true; accessToken = '' },
    async openUrl(url: URL) { await fetch(url) },
  }
}
