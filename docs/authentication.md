# Connect an authenticated MCP server

Use your MCP server's OAuth login, bearer token, or custom headers. These credentials are separate from the OpenAI API key used for simulation.

**Set your server URL first**

From your app's folder, create a configuration if you do not already have one:

```bash
ritmo init --server-url "https://your-server.example/mcp" --skip-check
```

Then choose the authentication method your server supports.

## OAuth login

**Sign in through your browser**

```bash
ritmo auth mcp --oauth
ritmo auth mcp --login
```

Complete authorization in the browser, then return to the terminal. Ritmo shows **Waiting for browser sign-in…**, then **Completing sign-in…** while exchanging the authorization and saving your login. Wait for the terminal's **Signed in** confirmation. The browser callback alone does not confirm completion.

Login waits up to two minutes. Press Ctrl+C to cancel. You can also connect from **MCP authentication → Connect / reconnect** in the simulator.

**Check your connection**

```bash
ritmo auth mcp
ritmo mcp --list-tools
```

Use `ritmo auth mcp --json` for machine-readable status.

**If your provider requires a registered client**

Use `--oauth --client-id CLIENT_ID` and, when required, `--client-secret-env MY_MCP_CLIENT_SECRET`. Supply the secret through your environment or secret manager. Register the exact callback `http://127.0.0.1:49178/callback`, or select another port with `--callback-port`.

If no client is registered, the server must support dynamic client registration. Use `--account NAME` to keep separate saved logins for the same endpoint.

Set `--token-endpoint-auth-method client_secret_post` only when the registration requires client credentials in the token request body. `client_secret_basic` selects HTTP Basic. Omitting it uses discovery/defaults. Ritmo reports a conflict rather than silently trying a different method.

## Environment-only custom headers

**Supply the secret, then save its variable name**

Set the variable through your shell or CI secret manager before starting Ritmo:

```bash
ritmo auth mcp --header-env X-API-Key=MY_MCP_KEY
```

The command stores the reference `MY_MCP_KEY`, not its value. Repeat `--header-env` for multiple headers. These flags replace the previous authentication configuration, so include all required headers when updating it.

### What to paste for a bearer token

If your provider shows `Authorization: Bearer demo-token-123`, the token is only `demo-token-123`. This is a made-up example. Leave out `Authorization:`, `Bearer`, quotes, and the surrounding command.

Store your actual token in `MY_MCP_TOKEN` using a secret manager or hidden local prompt, then run:

```bash
ritmo auth mcp --bearer-env MY_MCP_TOKEN
```

Pass the variable name to this command, never the token. Ritmo adds the `Bearer ` prefix.

In the browser panel, select **Custom header**, use `Authorization` as the header name and `MY_MCP_TOKEN` as the variable name, and check **Add Bearer prefix**. The token must already be available to the process that started Ritmo. Restart the simulator after changing its environment.

## Scope, storage and errors

OAuth logins are saved in the OS keychain. Header credentials can use environment variables or an existing keychain reference. See [configuration](config.md#mcp-authentication-serverauth) for every supported field.

- Credentials apply to the exact saved endpoint. Changing `server.url` removes the old references.
- HTTPS is required except for local loopback servers.
- Missing or empty secret references fail before connecting.
- OAuth owns the `Authorization` header; do not configure a bearer header alongside it.
- Set `RITMO_NO_KEYCHAIN=1` for environment-only header authentication in CI. Persistent OAuth requires a working keychain.
- Expired tokens refresh when possible. For denied or revoked access, sign in again.

**Forget a saved login**

```bash
ritmo auth mcp --clear
```

This removes the selected saved session. To also remove authentication settings from your project, follow it with `ritmo auth mcp --disable`. Revoke remote access through the provider's settings when needed.

Lenny's Data and GitHub registered-client OAuth have passed the recorded acceptance flows. Other providers may need different registration settings. Ritmo supports authorization code with S256 PKCE; device-code, client-credentials, and client-ID metadata-document flows are unsupported.

For callback, issuer, or keychain errors, see [Troubleshooting](troubleshooting.md). Existing AppRhythm credentials remain supported; see [migration](migration.md).
