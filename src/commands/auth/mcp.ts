import {Flags} from '@oclif/core'
import {RitmoCommand} from '../../lib/cli/command.js'
import {loadConfig} from '../../lib/config-loader.js'
import {createConnection, authenticationError} from '../../lib/mcp/connection.js'
import {saveMcpAuth} from '../../lib/mcp/auth-config.js'
import {McpOAuthProvider} from '../../lib/mcp/oauth.js'
import {McpError} from '../../lib/mcp/errors.js'
import type {McpAuthConfig} from '../../lib/mcp/auth-schema.js'

export default class McpAuth extends RitmoCommand {
  static override description = `Configure MCP authentication references, log in with OAuth, inspect status, or clear the selected session

For bearer authentication, set an environment variable using a secret manager or hidden local prompt. Store only the token, without Authorization:, Bearer, quotes, or the surrounding command. Synthetic example (not a working credential): from "Authorization: Bearer demo-token-123", store only demo-token-123. Ritmo adds the Bearer prefix.
Pass the variable NAME to --bearer-env, such as MY_MCP_TOKEN. Never paste a token into that flag or the browser's Environment variable name field.`
  private signedIn = false
  static override examples = [
    '<%= config.bin %> auth mcp --header-env X-API-Key=MY_MCP_KEY',
    '<%= config.bin %> auth mcp --bearer-env MY_MCP_TOKEN',
    '<%= config.bin %> auth mcp --oauth --client-id registered-client',
    '<%= config.bin %> auth mcp --login',
    '<%= config.bin %> auth mcp --clear',
  ]
  static override flags = {
    login: Flags.boolean({description: 'Open browser authorization and wait up to two minutes for the local callback', exclusive: ['clear', 'disable']}),
    clear: Flags.boolean({description: 'Forget OAuth tokens and registration for this endpoint/account; retain config references', exclusive: ['login', 'disable']}),
    disable: Flags.boolean({description: 'Remove authentication references from this project (does not revoke server tokens)', exclusive: ['oauth', 'header-env', 'bearer-env', 'login', 'clear']}),
    oauth: Flags.boolean({description: 'Configure OAuth authorization-code + PKCE'}),
    'client-id': Flags.string({description: 'Pre-registered OAuth client ID; omit to use advertised dynamic registration', dependsOn: ['oauth']}),
    'client-secret-env': Flags.string({description: 'Environment variable holding a pre-registered client secret', dependsOn: ['client-id']}),
    'token-endpoint-auth-method': Flags.string({description: 'Client authentication method required by a pre-registered confidential client; omit for SDK discovery/defaults', options: ['client_secret_basic', 'client_secret_post'], dependsOn: ['client-secret-env']}),
    account: Flags.string({description: 'Local OAuth account label used to isolate saved sessions', dependsOn: ['oauth']}),
    'callback-port': Flags.integer({description: 'Loopback callback port (default 49178)', dependsOn: ['oauth']}),
    'header-env': Flags.string({description: 'Header name and environment-variable reference: X-API-Key=MY_KEY (repeatable; never a secret value)', multiple: true}),
    'bearer-env': Flags.string({description: 'Environment variable NAME holding only the token (e.g. MY_MCP_TOKEN); never a token or Authorization header', exclusive: ['oauth']}),
    json: Flags.boolean({description: 'Print safe status as JSON'}),
  }
  async run(): Promise<void> {
    const {flags} = await this.parse(McpAuth)
    try {
      const config = await loadConfig()
      if (flags.oauth || flags['header-env'] || flags['bearer-env'] || flags.disable) {
        const next: McpAuthConfig = {}
        if (flags.oauth) next.oauth = {client_id: flags['client-id'], account: flags.account, callback_port: flags['callback-port'], ...(flags['client-secret-env'] ? {client_secret: {env: flags['client-secret-env']}} : {}), ...(flags['token-endpoint-auth-method'] ? {token_endpoint_auth_method: flags['token-endpoint-auth-method'] as 'client_secret_basic' | 'client_secret_post'} : {})}
        for (const entry of flags['header-env'] ?? []) {
          const match = /^([^=]+)=([A-Za-z_][A-Za-z0-9_]*)$/.exec(entry)
          if (!match) throw authenticationError('Use --header-env Header-Name=ENV_VARIABLE, never a secret value.')
          next.headers ??= {}; next.headers[match[1]] = {env: match[2]}
        }
        if (flags['bearer-env']) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(flags['bearer-env'])) throw authenticationError('Use --bearer-env MY_MCP_TOKEN with an environment variable name. Store only the token in that variable, without Authorization:, Bearer, quotes, or the surrounding command.')
          next.headers ??= {}; next.headers.Authorization = {env: flags['bearer-env'], prefix: 'Bearer '}
        }
        await saveMcpAuth(process.cwd(), config.server.url, next)
        config.server.auth = next
      }
      // Clearing must work even if an unrelated custom header reference is currently missing.
      if (flags.clear) {
        if (!config.server.auth?.oauth) throw authenticationError('OAuth is not configured for this endpoint.')
        await McpOAuthProvider.clearSession(config.server.url, config.server.auth.oauth)
      }
      const connection = await createConnection(config.server.url, config.server.auth)
      if (flags.login) {
        if (!connection.oauth) throw authenticationError('Configure OAuth first with `ritmo auth mcp --oauth` and any required --client-id.')
        if (!process.stdin.isTTY || !process.stdout.isTTY) throw authenticationError('Browser login requires an interactive terminal. In CI, configure an environment-backed Authorization header.')
        const controller = new AbortController()
        const cancel = () => controller.abort()
        process.once('SIGINT', cancel)
        try {
          await connection.oauth.login({
            signal: controller.signal, request: connection.fetch,
            onProgress: (phase) => {
              if (!flags.json) this.human(phase === 'waiting'
                ? 'Waiting for browser sign-in… Complete authorization in your browser, then return here. Ctrl+C cancels.'
                : 'Completing sign-in… Exchanging authorization and securely saving your login.')
            },
          })
          this.signedIn = true
        }
        catch (error) {
          if (!flags.json) this.human('Sign-in did not complete. Run `ritmo auth mcp --login` to try again.')
          throw error
        }
        finally { process.removeListener('SIGINT', cancel) }
      }
      const status = connection.oauth?.status() ?? {mode: Object.keys(config.server.auth?.headers ?? {}).length ? 'headers' : 'none', status: 'configured'}
      const output = {...status, headers: Object.keys(config.server.auth?.headers ?? {})}
      if (flags.json) this.log(JSON.stringify(output, null, 2))
      else {
        if (this.signedIn) this.human(`✓ Signed in to ${config.server.url}. Login securely saved.`)
        this.human(`MCP authentication: ${output.mode} · ${output.status}${flags.clear ? ' · saved OAuth session cleared' : ''}`)
      }
    } catch (error) { this.handleError(error) }
  }
  protected override nextCommand(): string { return this.signedIn ? 'ritmo mcp --list-tools' : super.nextCommand() }
  private handleError(error: unknown): never {
    if (error instanceof McpError) this.error(`[${error.category}] ${error.message}\n  Hint: ${error.hint ?? 'Review MCP authentication configuration.'}`, {exit: 1})
    this.error('[authentication] Could not configure MCP access. Check ritmo.yaml and keychain permissions.', {exit: 1})
  }
}
