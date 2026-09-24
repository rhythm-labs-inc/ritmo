/**
 * Shared types for the `validate` linter.
 *
 * A validation run collects a `ValidationContext` from the server (and the
 * local config), then applies a list of `Rule`s. Each rule returns zero or
 * more `Finding`s describing problems; the runner adds a `pass` finding for
 * every rule that reported nothing.
 *
 * Rule ids are stable strings (`tool/annotations-present`) so CI configs,
 * docs, and future YAML assertions can reference them.
 * The contract each rule enforces is documented in docs/apps-sdk-contract.md;
 * every rule cites the section it is based on via `source`.
 */

import type {RawResource, RawResourceContent, RawResourceResult, RawTool, ServerInfo} from '../mcp/client.js'
import type {AppRhythmConfig} from '../config-schema.js'
import type {Manifest} from '../manifest/snapshot.js'

export type Severity = 'fail' | 'warn' | 'info' | 'pass'

/**
 * Host profile the app is being validated/simulated for.
 *  - chatgpt:  OpenAI Apps SDK host (window.openai, openai/* _meta, portal rules)
 *  - mcp-apps: standard MCP Apps host such as Claude connectors (ui/* JSON-RPC, directory review criteria)
 * docs/apps-sdk-contract.md §9.
 */
export type HostProfile = 'chatgpt' | 'mcp-apps'
export const HOST_PROFILES: HostProfile[] = ['chatgpt', 'mcp-apps']

export interface Finding {
  /** Stable rule id, e.g. `tool/annotations-present`. */
  rule: string
  severity: Severity
  /** What the finding is about: a tool name, a resource URI, `server`, `config`, or `*`. */
  target: string
  message: string
  /** Remediation hint, same style as McpError.hint. */
  hint?: string
  /** Pointer into docs/apps-sdk-contract.md (e.g. `§2`) or an external URL. */
  source?: string
}

/** A widget template that a tool descriptor references, with what we could fetch. */
export interface WidgetTemplate {
  /** Raw result envelope for resource-level compatibility checks, never model input. */
  response?: RawResourceResult
  uri: string
  /** Tools whose descriptors reference this URI. */
  referencedBy: string[]
  /** Descriptor from `resources/list`, if the server listed it. */
  listed?: RawResource
  /** First `resources/read` content entry, if the read succeeded. */
  content?: RawResourceContent
  /** Error message if `resources/read` failed. */
  readError?: string
}

/** Result of a raw HTTP probe done outside the MCP SDK. */
export interface HttpProbe {
  url: string
  /** HTTP status, or undefined if the request failed before a response. */
  status?: number
  contentType?: string
  /** First bytes of the body (trimmed), when captured. */
  bodyPreview?: string
  error?: string
  durationMs: number
}

export interface ValidationProbes {
  /** Deep transport probes (initialize/OPTIONS/DELETE/Origin/body/error-hygiene/templates); see transport.ts. */
  transport?: import('./transport.js').TransportProbes
  /** GET <serverUrl> with Accept: text/event-stream (OpenAI's tool scanner does this). */
  sseGet?: HttpProbe
  /** GET https://<challenge_host>/.well-known/openai-apps-challenge (only when a token is configured). */
  challenge?: HttpProbe
}

export interface ValidationContext {
  serverUrl: string
  /** Host profile the rules should judge against. Default 'chatgpt'. */
  host?: HostProfile
  server: ServerInfo
  /** Raw HTTP probes; absent when probing was disabled. */
  probes: ValidationProbes
  tools: RawTool[]
  /** `null` when the server does not advertise the `resources` capability. */
  resources: RawResource[] | null
  /** Keyed by URI. Includes every `ui://` URI referenced by a tool plus every listed `ui://` resource. */
  templates: Map<string, WidgetTemplate>
  /** Local ritmo.yaml, when present. */
  config?: AppRhythmConfig
  /** Previously captured manifest (apprhythm.manifest.json), when present — enables manifest/* rules. */
  previousManifest?: Manifest
  /** Results of `--probe-tools` (live tools/call on zero-arg tools), when run. */
  probeResults?: ToolProbeResult[]
}

export interface ToolProbeResult {
  tool: string
  /** Full results of each call (readOnly tools are called twice). */
  results: import('../mcp/client.js').ToolCallResult[]
  error?: string
}

export interface Rule {
  id: string
  /** One-line description shown in `--list-rules` and next to pass lines. */
  description: string
  /** Section of docs/apps-sdk-contract.md this rule is based on. */
  source: string
  /** Hosts this rule applies to; absent = every host. */
  hosts?: HostProfile[]
  /** When present and false for a context, the rule is skipped entirely (no pass line). */
  applies?(ctx: ValidationContext): boolean
  check(ctx: ValidationContext): Finding[]
}

export interface ValidationSummary {
  fail: number
  warn: number
  info: number
  pass: number
}

/** Versioned policy provenance attached to a validation run. */
export interface ValidationPolicyInfo {
  bundleId: string
  bundleVersion: string
  bundleSha256: string
  rules: Array<{id: string; implementationVersion: string}>
}

/** Machine-readable `validate --json` and `doctor --json` report contract version. */
export const VALIDATION_REPORT_VERSION = 1

export interface ValidationReport {
  health?: import('./health.js').HealthReport
  version: typeof VALIDATION_REPORT_VERSION
  serverUrl: string
  host?: HostProfile
  serverName?: string
  toolCount: number
  templateCount: number
  findings: Finding[]
  summary: ValidationSummary
  /** Present when the caller records the policy bundle used for this run. */
  policy?: ValidationPolicyInfo
}
