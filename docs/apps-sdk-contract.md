# MCP, MCP Apps and host contract

Use this reference when changing validation or widget behaviour. Keep the numbered sections stable because code comments cite them.

- `[docs:…]` identifies an upstream requirement or specification.
- `[observed]` identifies behaviour seen during testing.
- `[implementation]` describes what Ritmo does today.

A passing local fixture verifies Ritmo behaviour, not host approval.

Sources: [MCP HTTP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview), [MCP Apps 2026-01-26 specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx), [OpenAI reference](https://developers.openai.com/plugins/reference), [OpenAI server guide](https://developers.openai.com/plugins/build/mcp-server), [OpenAI UI guide](https://developers.openai.com/plugins/build/chatgpt-ui), [OpenAI submission](https://developers.openai.com/plugins/deploy/submission), [OpenAI maintenance](https://developers.openai.com/plugins/deploy/app-review#continuous-review-and-tool-updates), and [Claude connector review](https://claude.com/docs/connectors/building/review-criteria). They were reviewed during toolkit development; recheck upstream sources before changing a rule or releasing against a new host contract.

## 1. Transport and server initialization

[docs:server] Ritmo supports Streamable HTTP MCP at a stable endpoint. Initialization exposes capabilities and optional server-wide instructions. Public host review needs a reachable production endpoint; the loopback example is a local fixture only. See the OpenAI server/submission sources above.

[observed] Some host scanners have rejected the otherwise protocol-permitted GET 405 response. The transport diagnostic records this compatibility distinction; it does not rewrite the MCP standard. CORS, Origin validation, session handling, request bounds and error hygiene matter independently of the model or UI. `doctor` probes those behaviors. Tool metadata cannot replace backend authorization.

## 2. Tool descriptors

[docs:reference] Tools need narrow names/descriptions, object input schemas, accurate read-only/destructive/open-world annotations, and applicable authentication declarations. A title helps permission/review UI. An output schema, when provided, describes the returned structured content. ChatGPT compatibility may mirror `securitySchemes` in `_meta`. These fields are declarations, not proof of implementation behavior.

[docs:apps] Standard UI links use `_meta.ui.resourceUri` and `_meta.ui.visibility`; `openai/outputTemplate` and `openai/widgetAccessible` are compatibility fields. OpenAI-specific invocation status strings are limited to 64 characters. Prefer portable keys when supported.

[docs:authorization] HTTP authorization uses protected-resource and authorization-server discovery, authorization code with PKCE, resource indicators and bearer tokens. Pre-registration and advertised dynamic registration are supported approaches; DCR is not guaranteed by every server. Tokens must remain bound to the intended resource.

[implementation] Ritmo implements explicit browser login, S256 PKCE, loopback callback state checking, endpoint/account/client-bound keychain persistence, refresh and invalidation. HTTPS is required outside loopback. Redirects and issuer changes are rejected. Ordinary commands never open a login browser implicitly. Client-ID metadata documents, device code and client-credentials grants are unsupported. Custom headers contain environment/keychain references, never literals. See [authentication](authentication.md). Recorded acceptance includes Lenny's Data OAuth and GitHub registered-client OAuth resource reads and installed CLI validation. Other provider configurations still need their own checks.

## 3. Widget resources

[docs:apps, docs:reference] Register a `ui://` resource and return HTML with `text/html;profile=mcp-app`. `text/html+skybridge` is legacy. Standard resource metadata lives in `_meta.ui`, including domain, CSP and border preference. Declare external resource/connect/frame origins explicitly. ChatGPT retains legacy widget metadata aliases and its own external redirect-domain extension.

[docs:maintenance] Rechecked September 22, 2026: OpenAI periodically scans published tools. Deleted tools are removed when detected; new and changed definitions become available after automated checks. A held update keeps the previous definition live, so keep your server compatible with it. See [continuous review](https://developers.openai.com/plugins/deploy/app-review#continuous-review-and-tool-updates).

[implementation] Ritmo's manifest comparison identifies metadata changes. It cannot prove that an updated server or widget remains compatible with a published definition.

[observed] Hosts have served cached widget bytes behind a stable resource URI. Content-versioned URIs are useful when the contract changes, but the observation does not establish indefinite caching or mandatory URI churn for every compatible content fix.

[docs:draft] The [MCP draft caching specification](https://modelcontextprotocol.io/specification/draft/server/utilities/caching), checked 2026-09-12, places nonnegative integer `ttlMs` and `cacheScope` (`public` or `private`) on cacheable result envelopes. It is draft guidance, not a universal stable-protocol requirement.

[observed] A ChatGPT resource read was rejected without those envelope fields on 2026-09-12; the failing negotiation was not captured. Ritmo checks them as dated observed compatibility in its ChatGPT profile. Portable-profile absence remains informational/unverified. Content-entry or `_meta` fields do not supply envelope hints. A `public` value does not prove that data is independent of caller identity.

## 4. Tool results

[docs:reference] `content` and `structuredContent` are model-visible. Result `_meta` is widget-only. `structuredContent` must match a declared output schema. `isError` signals a tool failure. Ritmo removes `_meta` before sending tool results to the model and checks for accidental duplication of hidden fields in visible data. If a server also places a secret in `content`, calling it hidden metadata cannot protect it.

## 5. Client-provided metadata and identity

[docs:reference] ChatGPT-specific hints can include `openai/subject`, `openai/session`, organization, locale, user agent and location. Hints can be missing or forged; never grant access or ownership from them. Ritmo can emulate subject/session continuity for the ChatGPT profile and omits these identity hints for the portable profile. These synthetic identifiers are not OAuth account identity.

## 6. Widget-to-host bridge

[docs:apps] Portable UI uses JSON-RPC over `postMessage`. Request `ui/initialize`, wait for the response, then send `ui/notifications/initialized` before receiving tool notifications. Relevant operations include tool calls, resource reads, open-link, messages, model-context updates, display-mode requests, size and teardown notifications. Host context supplies theme, sizing and related capabilities.

[docs:reference] ChatGPT's `window.openai` compatibility API exposes tool input/output, widget-only metadata, widget state, theme and display information. Feature-detect optional methods such as `callTool`, `setWidgetState`, `sendFollowUpMessage`, `requestDisplayMode`, `notifyIntrinsicHeight`, file access and external-link operations.

[implementation] Ritmo exposes a compatibility result envelope with `status`, `call_tool_result`, `mcp_tool_result` and the bare result. The precise top-level metadata shape across every real client is unverified. Optional state echo and height clipping reproduce observed behaviors. The shim approximates host CSS variables and sandbox conditions; it is not a complete host emulator.

## 7. Model behavior and simulation fidelity

[implementation] Ritmo calls OpenAI Chat Completions with a small local system prompt plus MCP server instructions. ChatGPT has its own routing, instructions and tool-selection behavior. Direct/indirect/negative prompts can therefore differ between simulation and a host. Prompt tests exercise expected interactions but do not certify production routing or safety. Record actual-host acceptance separately.

## 8. OpenAI submission

[docs:submission] Prepare listing details, production MCP access, appropriate reviewer access, tool justifications, prompts, test cases, release notes, and applicable skills and attestations. See [OpenAI's submission guide](https://developers.openai.com/plugins/deploy/submission).

**Current portal requirements and Ritmo coverage**

[docs:submission] Rechecked September 22, 2026: the submission guide says at least five positive and three negative tests; the [final-submission error reference](https://developers.openai.com/plugins/deploy/submission-errors#final-directory-submission) specifies exactly five and three. It also requires a demo-recording URL and all four website/support/privacy/terms URLs for remote MCP submissions. Screenshots apply to custom UI, with one per starter prompt, 706 pixels wide and 400–860 pixels tall.

[implementation] Ritmo currently checks minimum test counts, warns below three screenshots, and treats some website/support fields as recommendations. Its schema has no demo-recording field and does not cover all portal fields, limits, or screenshot dimensions. Use the current portal requirements when assembling the final submission; these differences can produce extra warnings or leave requirements unchecked.

[implementation] `package` writes draft Markdown and JSON. When submission cases exist, it also writes a test suite: positive checks require the first listed tool, and negative checks forbid all calls. It does not copy media or skill bundles, verify written expected results, run tests, upload materials, or decide approval. Review the files and strengthen generated assertions before replay.

## 9. Portable MCP Apps and Claude review

[docs:apps] Use `_meta.ui` fields and the `ui/*` bridge for portability; do not depend on OpenAI-specific identity or `window.openai` methods in a portable-only UI.

[docs:claude] Connector review expects clear titles/descriptions, honest annotations, separated read/write actions, useful successful/error results, and appropriate public documentation/test access. Tool descriptions must not inject unrelated behavioral instructions. Ritmo implements selected metadata, UI and listing checks; it does not establish API ownership, directory eligibility, public-repository availability or full host functional quality.

## 10. Updating this contract

Before changing a rule, read its primary source, record the verification date and evidence category here, add a synthetic fixture, and update user-visible command documentation. Keep unknown negotiation, caching, portal and client-version behavior explicit. A changed source or a local passing check is not itself actual-host acceptance.

## Local simulator and validation behaviour

[implementation] The simulator uses a local source-fidelity prompt and current-turn URL/title diagnostic; these are toolkit heuristics, not host requirements or semantic verification. Token counts are provider-reported; limited estimates and the dated official pricing source are documented in [simulation](simulation.md).

[implementation] Summary guidance preserves claim direction, audience, conditions, exceptions, uncertainty and speaker attribution. Missing answers and untested populations remain unknown. This is a local prompt policy within the existing completion calls, not an automatic semantic verifier or a guarantee of model accuracy. Opt-in live evaluations use synthetic excerpts and recorded review rubrics; successful execution is not a semantic pass.

[implementation] §2/§8 portal observations about missing annotations, security schemes and output schemas apply to the ChatGPT profile. §9's MCP Apps/Claude directory profile does not inherit those presence requirements. Local listing configuration is reported as local evidence, not as an inspection of remote policy/support pages. Description-quality text matching is inferred guidance, not verified semantic completeness.
