# Architecture

Ritmo has one TypeScript engine used by the CLI, local browser UI, and test runner.

**Find the code you need**

| Area | Location | Purpose |
|---|---|---|
| Commands | `src/commands` | Parse flags, call the engine, and format results |
| MCP connections | `src/lib/mcp` | Discovery, tools, resources, authentication, and identity |
| Validation | `src/lib/validate` | Rules, transport checks, and finding reports |
| Simulation | `src/lib/simulate` | Model provider, shared tool loop, traces, and usage |
| Widget bridge | `src/lib/simulate/widget` | Widget loading, host messages, and compatibility behaviour |
| Test runner | `src/lib/test-runner` | YAML suites, assertions, and reports |
| Local server | `src/lib/server` | Fastify routes for the simulator and widget preview |
| Browser UI | `src/ui` | Conversation, tools, widgets, authentication, and diagnostics |
| Submission material | `src/lib/package` | Build Markdown, JSON, and test drafts from configuration |

**Use the shared tool loop**

Both the simulator and test runner call `runHeadlessLoop` in `src/lib/simulate/headless-loop.ts`. Add behaviour there or through its callbacks so both workflows stay consistent.

Tool-result `_meta` is reserved for widgets and stays out of model messages. Source-reference guidance and link checks live in `source-fidelity.ts`; model usage and cost estimates live in `usage.ts`. The browser renders assistant Markdown through `AssistantMarkdown`, with raw HTML disabled.

## Versioned consumption

The package exports a small engine API through `src/lib/core/index.ts`:

```js
import {McpClient, runHeadlessLoop} from '@rhythm-labs-inc/ritmo'
```

Import from the package root and pin a tested version. This is an ESM Node package with a native `keytar` dependency. It is not a browser-only library.

`npm run verify:consumer` installs the tarball in a separate project and exercises the exported API, CLI, and browser assets using local fixtures.

## Release contents

`SOURCE-MANIFEST.json` lists the source files included in the release. After building, `RELEASE-CONTENTS.json` records the packaged files and their hashes. The package checks reject unexpected files, missing commands, and missing browser assets.

The package provides `ritmo` and the compatible `apprhythm` executable. Both run the same entry point. See [migration](migration.md) for configuration and credential compatibility.

## Contract changes

Use the [host contract reference](apps-sdk-contract.md) when changing validation or widget behaviour. Its numbered sections are cited by code comments. Keep official requirements, observed behaviour, and implementation limits clearly identified.

Cover changes with fixtures and check host-specific behaviour in the target host. The [release process](releasing.md) describes the checks required before publishing.

## Source-summary evaluation

`scripts/evaluate-simulator-summaries.mjs` runs the real model provider against synthetic source records. It saves prompts, answers, usage, and review criteria. It requires an explicit `--live` flag because it makes paid calls; it is separate from normal CI.

The model receives a bounded copy of whole source excerpts beside their titles and URLs: at most five excerpts per source, 6,000 characters per excerpt, and 30,000 characters per tool result. Oversized excerpts are skipped in that copy; the original model-visible tool content is unchanged. This improves the context available to the model but does not verify answer accuracy. See [simulation](simulation.md#recheck-snippet-summaries-with-a-live-model).
