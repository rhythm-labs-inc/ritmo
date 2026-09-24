# Configuration

Configure your app, tests, and widget previews with three types of file:

- `ritmo.yaml` describes the app, MCP server, simulation model, test files, and optional submission material.
- Test YAML files describe prompts and the results you expect.
- Widget fixture JSON files provide UI states and sample tool results.

**Start with `ritmo.yaml`, then add tests as you develop your app.** The examples below use a fictional project-management app; replace its names, paths, and URLs with your own.

## `ritmo.yaml`

Ritmo reads `ritmo.yaml` from the current working directory. It does not search parent directories. Existing `apprhythm.yaml` files are still supported. If both names exist, choose one before continuing; see [migration](migration.md).

Create a starter file with:

```bash
ritmo init
```

The config schema is strict: misspelled or unknown keys are errors. Validation messages include the field path and a suggested fix.

## Smallest useful config

```yaml
version: 1

app:
  name: "Project Helper"
  description: "Finds and updates projects"
  icon: "./assets/icon.png"
  screenshots: []

server:
  url: "http://localhost:3000/mcp"

simulate:
  model: "gpt-4o-mini"
  default_context:
    locale: "en-US"
    timezone: "UTC"

tests:
  - file: "./tests/smoke.yaml"
```

This is enough to start local development. Create `tests/smoke.yaml` before running tests, or save a reviewed draft from the [simulator](simulation.md). Fill in listing assets and submission details as your app develops.

## Root fields

| Field | Required | Purpose |
|---|---:|---|
| `version` | Yes | Config version; the only accepted value is `1` |
| `app` | Yes | Local listing and submission metadata |
| `server` | Yes | MCP endpoint |
| `simulate` | Yes | Model and host context |
| `tests` | Yes | One or more test-suite files |
| `submission` | No | Review-only material that cannot be discovered from the server |

## `app`

```yaml
app:
  name: "Project Helper"
  subtitle: "Projects, without the busywork"
  description: "Find, summarize, and update projects from ChatGPT."
  icon: "./assets/icon.png"
  screenshots:
    - "./assets/screenshots/search.png"
    - "./assets/screenshots/detail.png"
    - "./assets/screenshots/update.png"
  privacy_policy_url: "https://example.com/privacy"
  company_url: "https://example.com"
  support_url: "https://example.com/support"
  terms_url: "https://example.com/terms"
```

| Field | Format | What Ritmo checks |
|---|---|---|
| `name` | Required non-empty string | ChatGPT profile fails over 30 characters |
| `subtitle` | Optional non-empty string | Warns when absent; fails over 30 characters |
| `description` | Required non-empty string | Short descriptions receive an informational finding |
| `icon` | Required non-empty path | Checks for an existing 1024×1024 PNG |
| `screenshots` | String array; defaults to `[]` | Currently warns below 3; see the portal differences below |
| `privacy_policy_url` | Optional HTTPS URL | Missing value fails submission validation |
| `company_url` | Optional HTTPS URL | Company or support URL is recommended |
| `support_url` | Optional HTTPS URL | Also serves as public help/documentation for portability checks |
| `terms_url` | Optional HTTPS URL | Missing value fails ChatGPT submission validation |

Paths are relative to the folder where you run Ritmo. You can start simulation before adding your icon or screenshots.

These are the checks implemented in Ritmo, not a complete list of current portal requirements. Screenshot requirements in particular differ; read [OpenAI submission coverage](apps-sdk-contract.md#8-openai-submission) before preparing final assets.

## `server`

```yaml
server:
  url: "https://api.example.com/mcp"
```

`server.url` is required and must use `http://` or `https://`. Ritmo supports MCP Streamable HTTP; it does not support stdio or legacy SSE-only endpoints.

Commands with `--server` can override this value. `doctor` can also take the URL as its positional argument.

## MCP authentication (`server.auth`)

Authentication belongs to the exact configured MCP endpoint. It is separate from the OpenAI model API key and simulated host identity. HTTPS is required outside loopback. CLI URL overrides use credentials only when they match `server.url`; saving a different endpoint removes the old references. Reconfigure explicitly for the new endpoint.

```yaml
server:
  url: https://example.com/mcp
  auth:
    headers:
      X-API-Key:
        env: MY_MCP_KEY
      # For a bearer-only server, use this instead of OAuth:
      # Authorization: {env: MY_MCP_TOKEN, prefix: 'Bearer '}
    oauth:
      account: default
      # Optional pre-registration (otherwise the server must advertise DCR):
      # client_id: registered-client
      # client_secret: {env: MY_MCP_CLIENT_SECRET}
      # Only when required by that client registration:
      # token_endpoint_auth_method: client_secret_post
      callback_port: 49178
      # scope: 'read write'
```

**Header references**

Use `{env: VARIABLE}` or `{keychain: ACCOUNT}` for each header, with an optional `prefix`. Set environment variables before starting Ritmo. Missing or empty references fail before connecting. Custom keychain references use the `ritmo` service with legacy fallback; provision them through your OS keychain tools.

Header names are case-insensitively unique. Protocol/browser headers are reserved. OAuth uses `Authorization`, so it cannot be combined with a separately configured bearer header.

**OAuth settings**

| Field | Purpose |
|---|---|
| `account` | Local label for a saved login; defaults to `default` |
| `client_id` | Registered client ID; omit only when the server supports dynamic registration |
| `client_secret` | Environment/keychain reference for a confidential client's secret; requires `client_id` |
| `token_endpoint_auth_method` | `client_secret_basic` or `client_secret_post`; requires a client ID and secret |
| `callback_port` | Local callback port, 1024–65535; defaults to 49178 |
| `scope` | Fallback scope when the server challenge and discovery do not supply it |

Register the exact callback `http://127.0.0.1:49178/callback`, or the equivalent URL for your chosen port. Leave `token_endpoint_auth_method` unset unless your registration requires a particular method. Ritmo uses discovery/defaults and reports conflicts instead of retrying another method.

Run `ritmo auth mcp --login` or choose **Connect / reconnect** in the simulator. Tokens persist in the OS keychain, bound to the endpoint, account label, client, callback, and scope. Login is explicit; ordinary commands do not open an authorization browser.

Expired tokens refresh when possible. Use `--clear` to forget the selected saved login and `--disable` to remove its project settings. Clear before disabling if you want both removed.

Ritmo supports authorization code with S256 PKCE, metadata discovery, registered clients, and dynamic registration. Metadata must identify the exact resource. Redirects are rejected, and an OAuth issuer change requires clearing and reconnecting. Device-code, client-credentials, and client-ID metadata-document flows are unsupported.

See [authentication](authentication.md) for setup steps and bearer-token examples, and [migration](migration.md) for legacy credential behaviour.

## `simulate`

```yaml
simulate:
  model: "gpt-4o-mini"
  default_context:
    locale: "en-US"
    timezone: "America/Vancouver"
```

| Field | Behavior |
|---|---|
| `model` | OpenAI Chat Completions model id used by `simulate` and `test` |
| `default_context.locale` | Sent as simulated `openai/locale` on ChatGPT-profile tool calls |
| `default_context.timezone` | Required and parsed, but not currently forwarded to the model or tool calls |

Ritmo does not verify model availability while loading config. The OpenAI SDK reports unsupported or inaccessible models at runtime.

## `tests`

```yaml
tests:
  - file: "./tests/smoke.yaml"
  - file: "./tests/regression.yaml"
```

At least one entry is required. `ritmo test` runs these files in order unless `--file` selects one suite.

## `submission`

Add your listing and review material here. Ritmo uses it for validation and to generate the files in `submission/`. The example contains one positive and one negative case; add the remaining cases for your app.

```yaml
submission:
  challenge_token: "replace-with-portal-token"
  challenge_host: "api.example.com"

  showcase_prompts:
    - "Show me the projects that need attention"
    - "Summarize progress on the launch project"

  test_cases:
    - scenario: "List active projects"
      prompt: "Show me my active projects"
      tools: [list_projects]
      expected: "Returns project ids, names, owners, and status"
      fixture: "Reviewer account contains at least two active projects"

  negative_test_cases:
    - scenario: "Unrelated writing request"
      prompt: "Write a birthday poem"
      rationale: "The request does not need project data or actions"

  tools:
    list_projects:
      justifications:
        readOnlyHint: "Only reads projects"
        destructiveHint: "Does not delete or overwrite data"
        openWorldHint: "Does not publish outside the user's account"

  skills:
    - name: "project-workflow"
      path: "./skills/project-workflow"
      delivery: "bundle"

  country_availability: [CA, US]

  policy_attestations:
    confirmed: false  # set true only after the release owner reviews the final draft
    # confirmed_by: "Release owner"
    # confirmed_at: "2026-09-22T12:00:00Z"

  release_notes:
    kind: "initial"
    summary: "Initial project-workflow submission."
    changes: "Initial release with project lookup and update tools."
    reviewer_notes: "Reviewer account has two active projects and does not require MFA."
```

| Field | Shape | Used by |
|---|---|---|
| `challenge_token` | Optional non-empty string | `validate` and `doctor` check the exact well-known response |
| `challenge_host` | Optional host | Overrides the host derived from `server.url` |
| `showcase_prompts` | String array; defaults to `[]` | `validate`, `package` |
| `test_cases` | Positive case array; defaults to `[]` | `validate`, `package` |
| `negative_test_cases` | Negative case array; defaults to `[]` | `validate`, `package` |
| `tools` | Map keyed by live tool name; defaults to `{}` | Annotation-justification checks and generated package |
| `skills` | `{name, path, delivery}` array; defaults to `[]` | Validates local directories have `SKILL.md`; emits skills inventory. `delivery` is `bundle` or `mcp-import` |
| `country_availability` | Uppercase ISO 3166-1 alpha-2 string array; defaults to `[]` | Requires a country choice and emits Global-tab material |
| `policy_attestations` | Optional `{confirmed, confirmed_by, confirmed_at}` | Records a human final-draft confirmation; not a policy certificate |
| `release_notes` | Optional `{kind, summary, changes, reviewer_notes}` | Requires portal-ready release-note material and emits Markdown |

**Check and export the draft**

Ritmo currently checks for at least five positive and three negative cases, one to three showcase prompts, and tool-annotation justifications. You can fill in the material gradually; `validate` reports missing fields. The current portal has additional requirements described in [submission coverage](apps-sdk-contract.md#8-openai-submission).

```bash
ritmo validate --host chatgpt
ritmo package --out ./submission
```

The export includes listing copy, test descriptions, annotation justifications, skills and availability notes, release notes, and `submission.json`. It references your icon, screenshots, and skill paths; it does not copy those assets or create an upload ZIP.

When positive or negative cases are configured, it also creates `tests/submission.yaml`. Generated positive checks require only the first tool listed in each case; negative checks forbid all calls. They do not automatically assert the written expected result or every tool in a workflow. Review and extend them before replay:

```bash
ritmo test --file submission/tests/submission.yaml --runs 1
```

Packaging can succeed with missing material, or fall back to configuration-only output if the server is unreachable. Read its warnings and review the files before using them for submission.

`skills[].path` is the tested local directory and must contain `SKILL.md`. Ritmo never executes it or claims it passed OpenAI scanning. For `delivery: mcp-import`, scan the portal again after the server skill changes and confirm the imported snapshot. Country readiness and policy attestations are human decisions; Ritmo keeps their evidence but cannot certify them.

## Credentials

Simulation and test replay currently use OpenAI. Keep your model key separate from MCP server credentials.

Credential resolution order:

1. `RITMO_OPENAI_API_KEY`, after trimming whitespace.
2. OS keychain through `keytar`, using service `ritmo` and account `openai`, with legacy `apprhythm` service fallback.

A nonempty environment key wins over a keychain entry. An empty or whitespace-only selected key falls through to the keychain; see [migration](migration.md#environment-precedence) for legacy-variable precedence.

```bash
# Interactive local setup
ritmo auth set-key --provider openai

# Confirm the active source without printing the secret
ritmo auth status
```

For CI, supply `RITMO_OPENAI_API_KEY` through your secret manager. On Linux, keychain access requires Secret Service / `libsecret`. If keytar cannot load, use the environment variable. `RITMO_NO_KEYCHAIN=1` skips keychain access entirely.

## Environment variables

| Variable | Effect |
|---|---|
| `RITMO_OPENAI_API_KEY` | OpenAI key for `simulate` and `test`; overrides keychain |
| `RITMO_SUBJECT` | Default simulated `openai/subject`; CLI identity flags override it |
| `RITMO_NO_KEYCHAIN` | A nonempty value other than `0` or `false` disables keychain lookup |
| `RITMO_NO_HISTORY` | Presence disables terminal validation history, even with an empty value |

Server URL, model, port, and request timeout do not have environment-variable forms.

## Simulated identity

ChatGPT-profile tool calls can include:

```text
openai/subject   anonymized user id
openai/session   anonymized conversation id
openai/locale    locale hint
```

By default Ritmo creates a subject once per project directory and stores it in `.ritmo/identity.json`. That file should remain gitignored. A session id is fresh for each conversation.

| Control | Result |
|---|---|
| `--subject alice` | Use `alice` for this invocation; do not persist it |
| `--new-user` | Generate and persist a new subject |
| `--no-identity` | Send none of the `openai/*` identity keys |
| `ritmo mcp --call TOOL --forge-subject attacker` | Send a chosen value and label that tool call as a security test |
| `RITMO_SUBJECT=alice` | Set the default subject when no CLI override exists |

The `mcp-apps` host profile sends no OpenAI identity metadata. Servers must never use `openai/subject` as authorization; any MCP client can forge it.

## Test suites

Test suites are YAML files referenced by `tests[].file` or selected with `ritmo test --file`.

### Single-turn cases

```yaml
suite: "Project Helper smoke tests"

tests:
  - name: "Lists open projects"
    class: direct
    user: "Show me my open projects"
    expect_tool: list_projects
    assert_tool_param:
      status: "open"
    assert_response_contains: "project"

  - name: "Does not trigger for unrelated writing"
    class: negative
    user: "Write me a birthday poem"
    expect_no_tool_call: true
```

`suite` and case `name` are optional. A case must contain exactly one of `user` or `turns`.

### Multi-turn cases

```yaml
tests:
  - name: "Open a project, then update it"
    turns:
      - user: "Open project Atlas"
        tools_called: [get_project]

      - user: "Mark it at risk"
        tools_called: [update_project]
        assert_tool_param:
          status: "at_risk"

    assert_response_contains: "at risk"
```

Turns share one model conversation and prior messages. Assertions inside a turn apply to that turn. Top-level assertions on a multi-turn case apply to the final turn.

Each test case starts a fresh model conversation. All cases in one command share the same MCP connection.

### Assertions

| Key | Passes when… |
|---|---|
| `expect_tool: name` | The named tool ran at least once in this turn |
| `tools_called: [a, b]` | Every listed tool ran; an empty list means no tool ran |
| `tools_not_called: [x]` | None of the listed tools ran |
| `expect_no_tool_call: true` | No tool ran |
| `assert_tool_param: {key: value}` | Shallow-merged arguments from all calls contain JSON-equal values; later calls win on duplicate keys |
| `assert_response_contains: text` | The final assistant response contains the text, case-insensitively |
| `assert_contract: clean` | No contract finding of any severity was produced by a tool result |
| `assert_contract: no-fail` | No failing contract finding was produced |
| `no_claim_without_call` | If response text matches a regex, the named tool must have run |

Honesty example:

```yaml
no_claim_without_call:
  - pattern: "opened|reopened|updated"
    requires_tool: update_project
```

A case with no assertions passes when the simulation finishes without a runtime error.

### Discovery classes

Set `class` to `direct`, `indirect`, or `negative` to group results in the discovery reporter:

```bash
ritmo test --reporter discovery --runs 5
```

The report calculates per-tool precision/recall and invocation/pass counts by class. These metrics describe Ritmo's simulator, not guaranteed production ChatGPT routing.

### Identity inside suites

Set identity at the case or turn level:

```yaml
tests:
  - name: "Same user, new conversation"
    identity:
      subject: "returning-user"
      session: new
    user: "Continue my project setup"
    expect_tool: get_project

  - name: "Host without OpenAI identity"
    identity:
      none: true
    user: "List public projects"
```

| Identity key | Values |
|---|---|
| `subject` | Any non-empty string; special value `new` creates a random subject |
| `session` | `same` or `new` |
| `none` | Literal `true` to send no identity metadata |

Turn-level identity overrides case-level identity.

## Widget fixtures

The standalone widget harness accepts fixture JSON through `--data`.

```json
{
  "toolName": "show_projects",
  "states": {
    "loading": {
      "toolInput": {"status": "open"},
      "toolOutput": {"projects": []},
      "toolResponseMetadata": {},
      "widgetState": null
    },
    "results": {
      "toolInput": {"status": "open"},
      "toolOutput": {
        "projects": [{"id": "p1", "name": "Atlas"}]
      },
      "toolResponseMetadata": {"nextCursor": null},
      "widgetState": {"selectedId": "p1"}
    }
  },
  "tools": {
    "archive_project": {
      "content": [{"type": "text", "text": "Archived."}],
      "structuredContent": {"projectId": "p1", "archived": true},
      "_meta": {"auditId": "audit-123"}
    }
  }
}
```

| Key | Purpose |
|---|---|
| `toolName` | Optional label shown for the mounted widget |
| `states` | Named mount snapshots available in the state picker |
| `states.*.toolInput` | Value exposed as tool input |
| `states.*.toolOutput` | `structuredContent` exposed to the widget |
| `states.*.toolResponseMetadata` | Widget-only result metadata; the ChatGPT shim wraps it in the expected envelope |
| `states.*.widgetState` | Persisted UI state snapshot |
| `tools` | Canned full MCP results returned by widget `callTool` requests |

A flat object containing `toolInput`, `toolOutput`, and related fields is treated as a single state named `default`.

If a widget calls a tool not present in `tools`, the harness forwards the call to `--server` when provided. Otherwise it reports an error in the Events tab.

See the included [notes fixture](../examples/notes/states.json) and [simulation guide](simulation.md) for a complete example.

## Blueprint compatibility

`simulate --blueprint FILE` and `test --blueprint FILE` accept an existing v1 Blueprint. Use `--environment NAME` to choose its delivery environment. The JSON schema is in `schemas/ritmo-plugin-blueprint-v1.schema.json`. This package does not generate Blueprints or provide conversion workflows.

## Common config errors

| Error | Fix |
|---|---|
| Config file not found | Run from the directory containing `ritmo.yaml`, or run `ritmo init` |
| `version` rejected | Set `version: 1` |
| `server.url` rejected | Use a complete `http://` or `https://` URL |
| Unknown key | Remove it or correct the spelling; the config schema is strict |
| Missing test file | Resolve the path relative to the command's working directory |
| Missing OpenAI credential | Set the environment variable or use `auth set-key` |


See [migration](migration.md) if you have older AppRhythm configuration, environment variables, state, or saved credentials.
