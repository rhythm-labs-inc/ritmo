# Commands

Run `ritmo COMMAND --help` for the options and examples for any command. Use spaces between topics, such as `ritmo auth mcp`.

**Set up and connect**

| Command | What it does | Useful options |
|---|---|---|
| `ritmo init` | Create `ritmo.yaml` with your MCP server URL | `--server-url`, `--skip-check`, `--no-interactive` |
| `ritmo config show` | Show your configuration with secrets redacted | `--help` |
| `ritmo config set` | Update a supported setting | `server.url URL` |
| `ritmo mcp` | List tools and resources, or call a tool | `--list-tools`, `--call`, `--args`, `--server` |
| `ritmo auth mcp` | Configure MCP authentication, sign in, or check status | `--oauth`, `--login`, `--bearer-env`, `--header-env`, `--clear` |
| `ritmo auth set-key` | Save your OpenAI API key using a hidden prompt | `--provider openai` |
| `ritmo auth status` | Show which model credential source is active | `--help` |
| `ritmo auth remove-key` | Remove a saved model key | `--provider openai` |

**Develop, test, and prepare submission materials**

| Command | What it does | Useful options |
|---|---|---|
| `ritmo validate` | Check tools, metadata, resources, transport, and submission details | `--host`, `--no-probe`, `--fail-on`, `--json` |
| `ritmo doctor` | Diagnose transport and connection issues | `--help` |
| `ritmo simulate` | Open the conversation simulator or run a prompt in the terminal | `--host`, `--port`, `--headless --message` |
| `ritmo widget SOURCE` | Preview an HTML file or MCP widget resource | `--data`, `--server`, `--host`, `--theme`, `--viewport` |
| `ritmo test` | Replay YAML scenarios and check assertions | `--file`, `--runs`, `--reporter cli\|junit\|discovery` |
| `ritmo manifest snapshot` | Save a snapshot of server metadata | `--help` |
| `ritmo manifest diff` | Compare server metadata with a saved snapshot | `--help` |
| `ritmo package` | Write draft submission materials | `--out`, `--no-connect` |
| `ritmo inspect FILE` | Display redacted JSON or YAML fields | `--section`, `--json` |

All commands above are implemented. `apprhythm` remains an executable alias; see [migration](migration.md) for older projects. Existing v1 Blueprint inputs are supported by `simulate` and `test` through `--blueprint`.

## Choose a host profile

Use `--host chatgpt` for ChatGPT compatibility checks and its widget bridge. Use `--host mcp-apps` for the portable MCP Apps bridge and Claude directory guidance. The simulator approximates these hosts; verify your finished app in its target host.

## Output, side effects and exit status

Commands show progress, findings, and a suggested next step. Use JSON or JUnit output when another tool needs to read the results.

- `validate` exits 1 for failing findings. Add `--fail-on warn` to fail on warnings too.
- `test` exits 1 if a case fails or errors.
- A successful `package` means files were written. It does not run tests or submit the app.
- `mcp --call`, simulation, and replay execute tools on your server. Use appropriate test data and permissions.
- Normal validation checks metadata and transport. `--no-probe` skips transport probes; `--probe-tools` opts into business-tool calls.

Normal terminal validation saves a small comparison history in `.ritmo/terminal-history.json`. Set `RITMO_NO_HISTORY=1` to disable it. JSON and quiet output do not use this history.

## Validation finding context

Each non-pass finding identifies its scope, the inspected field or resource, and its source. A missing privacy URL in `ritmo.yaml` is a configuration finding; it does not mean Ritmo inspected your website and found no policy.

Some checks apply only to the ChatGPT profile, including annotation/security-scheme presence and missing-output-schema warnings. The MCP Apps profile uses portable checks and directory guidance. Declared output schemas are checked in both profiles.

Description guidance uses text patterns and can miss valid wording. Submission checks cover only part of the current portal requirements; review the [documented differences](apps-sdk-contract.md#8-openai-submission) before submitting.

See [configuration](config.md), [authentication](authentication.md), and [simulation](simulation.md) for complete workflows.
