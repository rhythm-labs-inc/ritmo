# Give Ritmo to your coding agent

Use Ritmo to help develop and test the user's MCP-powered app. Follow the app project's instructions and preserve existing work. For changes to Ritmo itself, read [Contributing](../CONTRIBUTING.md).

**Start with the app**

Inspect the project, its MCP server, and any existing `ritmo.yaml`. Establish the intended interaction and target host from context; ask only for missing decisions. Ritmo connects to Streamable HTTP MCP endpoints. Stdio and legacy SSE-only servers are unsupported.

If the app needs a server, build it in the user's project. Keep the toolkit checkout separate.

**Set up Ritmo**

Reuse an installed CLI after checking `ritmo --version` and help. For a source checkout, use Node 22.23.2 or newer:

```bash
npm ci
npm run build:all
```

Run `npm link` for a global command if that fits the user's setup, or invoke `node /absolute/path/to/ritmo/bin/run.js`. Source is available on [GitHub](https://github.com/rhythm-labs-inc/ritmo); clone the public repository for the source setup above. The published release candidate can also be installed with `npm install -g @rhythm-labs-inc/ritmo@0.2.0-rc.1`. See [installation](installation.md).

Return to the user's app folder. Reuse its configuration, or create one with the actual server URL:

```bash
ritmo init --server-url "https://your-server.example/mcp" --skip-check --no-interactive
```

This creates starter settings, not a server or test suite. Ritmo reads the current folder only. Update placeholder app details as the project develops.

**Connect securely**

MCP authentication and the OpenAI model key are separate. Reuse working credentials. For OAuth:

```bash
ritmo auth mcp --oauth
ritmo auth mcp --login
```

Let the user complete browser authorization and wait for the CLI confirmation. For a bearer token, have the user store only the token in an environment variable through a hidden local prompt or secret manager, then save its reference:

```bash
ritmo auth mcp --bearer-env MY_MCP_TOKEN
```

For the made-up header `Authorization: Bearer demo-token-123`, store only `demo-token-123`. Never ask for secrets in chat, write them into project files or shell history, or print them. These auth flags replace the previous settings. See [authentication](authentication.md).

**Discover, validate, and fix**

```bash
ritmo mcp --list-tools
ritmo validate --host chatgpt --no-probe --json > ritmo-validation.json
```

Choose a new or reviewed report path. Read the JSON even when validation exits 1. Use the discovered tool names and schemas. Fix the relevant app files and rerun affected checks; distinguish server defects from missing listing details. Remove `--no-probe` when ready to check transport behaviour. Use `--host mcp-apps` for the portable profile.

**Try the interaction and save tests**

Reuse the user's OpenAI key or have them run `ritmo auth set-key --provider openai` at its hidden prompt. Confirm paid usage only if the user has not already authorized it. Tool calls can change server data, so stay within the user's authorized actions.

```bash
ritmo simulate --host chatgpt
```

Review the conversation, tool results, answer accuracy, and any widgets with the user. Author a test suite or review and save a simulator smoke draft before running:

```bash
ritmo test --file tests/smoke.yaml --runs 1
```

Use [test assertions](config.md#test-suites) for expected tools, arguments, responses, and contracts. For a widget without model calls, use `ritmo widget FILE --data FIXTURES --host chatgpt` with actual local paths. See [simulation](simulation.md).

**Prepare submission materials**

Help fill in the app and submission fields in [configuration](config.md). Run validation, review outstanding findings, then export to a new or reviewed output directory:

```bash
ritmo package --out ./submission
```

Read the missing-material messages and generated files. Packaging can fall back to configuration-only output when the server is unreachable. Generated tests check basic tool calls; review and strengthen their assertions before replaying them. Check the [portal coverage limits](apps-sdk-contract.md#8-openai-submission) and guide the user through actual-host testing.

After each useful iteration, report what changed, what was verified, and the next unresolved step. Passing local checks does not mean the app was submitted or approved.
