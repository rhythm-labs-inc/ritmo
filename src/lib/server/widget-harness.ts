import type {McpAuthConfig} from '../mcp/auth-schema.js'
/**
 * Standalone widget harness (`ritmo widget`) — no model, no API key.
 *
 * Loads a widget template from a local HTML file (watched for changes) or a
 * `ui://` URI on an MCP server, plus a JSON fixture with named states and
 * canned tool results, and mounts it through the same Simulator/session/bridge
 * the full simulator uses — so the shim, Events tab and host quirks are identical.
 *
 * Fixture format (docs/config.md → "Widget fixtures"):
 * {
 *   "states": {
 *     "intro":    {"toolInput": {...}, "toolOutput": {...}, "toolResponseMetadata": {...}, "widgetState": null},
 *     "complete": {...}
 *   },
 *   "tools": {                    // canned callTool results, keyed by tool name
 *     "save_card": {"content": [...], "structuredContent": {...}, "_meta": {...}}
 *   },
 *   "toolName": "rhythm_builder_start"   // optional; label for the mount
 * }
 * A flat legacy fixture {toolInput, toolOutput, ...} is treated as a single "default" state.
 */

import {watch, type FSWatcher} from 'node:fs'
import {readFile} from 'node:fs/promises'
import path from 'node:path'

import type {ToolCallResult} from '../mcp/client.js'
import {McpClient} from '../mcp/client.js'
import type {WidgetSource} from '../simulate/widget/types.js'

export interface FixtureState {
  toolInput?: Record<string, unknown>
  toolOutput?: Record<string, unknown> | null
  toolResponseMetadata?: Record<string, unknown> | null
  widgetState?: Record<string, unknown> | null
}

export interface WidgetFixture {
  states: Record<string, FixtureState>
  tools: Record<string, ToolCallResult>
  toolName?: string
}

export interface HarnessLoadOptions {
  /** Local HTML file path or ui:// URI. */
  source: string
  /** MCP server URL — required for ui:// sources; optional fallback for callTool. */
  serverUrl?: string
  auth?: McpAuthConfig
  /** Fixture file path (JSON). */
  fixturePath?: string
  cwd?: string
}

export interface HarnessLoaded {
  source: WidgetSource
  fixture: WidgetFixture
  /** Human label of what was loaded. */
  label: string
}

const EMPTY_FIXTURE: WidgetFixture = {states: {default: {toolInput: {}, toolOutput: null, toolResponseMetadata: null, widgetState: null}}, tools: {}}

/** Parse + normalise a fixture JSON string. */
export function parseFixture(json: string): WidgetFixture {
  const raw = JSON.parse(json) as Record<string, unknown>
  if (raw && typeof raw === 'object' && raw.states && typeof raw.states === 'object') {
    const states = raw.states as Record<string, FixtureState>
    if (Object.keys(states).length === 0) throw new Error('fixture "states" must not be empty')
    return {
      states,
      tools: (raw.tools && typeof raw.tools === 'object' ? raw.tools : {}) as Record<string, ToolCallResult>,
      toolName: typeof raw.toolName === 'string' ? raw.toolName : undefined,
    }
  }
  // Legacy flat shape (examples/widgets/sample-app/test-data.json era) → single state
  const flat = raw as FixtureState & {tools?: Record<string, ToolCallResult>; toolName?: string}
  return {
    states: {default: {toolInput: flat.toolInput ?? {}, toolOutput: flat.toolOutput ?? null, toolResponseMetadata: flat.toolResponseMetadata ?? null, widgetState: flat.widgetState ?? null}},
    tools: flat.tools ?? {},
    toolName: flat.toolName,
  }
}

export class WidgetHarness {
  private watcher: FSWatcher | null = null
  private fixtureWatcher: FSWatcher | null = null
  private readonly cwd: string
  private onChangeCb: (() => void) | null = null

  constructor(private readonly options: HarnessLoadOptions) {
    this.cwd = options.cwd ?? process.cwd()
  }

  get isFile(): boolean {
    return !this.options.source.startsWith('ui://')
  }

  get label(): string {
    return this.isFile ? path.relative(this.cwd, path.resolve(this.cwd, this.options.source)) : `${this.options.source} @ ${this.options.serverUrl ?? '?'}`
  }

  /** Load (or reload) the template + fixture. */
  async load(): Promise<HarnessLoaded> {
    const [source, fixture] = await Promise.all([this.loadSource(), this.loadFixture()])
    return {source, fixture, label: this.label}
  }

  /** Watch the HTML file and fixture for changes (file sources only). */
  watch(onChange: () => void): boolean {
    this.onChangeCb = onChange
    if (!this.isFile) return false
    const debounced = debounce(() => this.onChangeCb?.(), 150)
    try {
      this.watcher = watch(path.resolve(this.cwd, this.options.source), debounced)
      if (this.options.fixturePath) {
        this.fixtureWatcher = watch(path.resolve(this.cwd, this.options.fixturePath), debounced)
      }
      return true
    } catch {
      return false
    }
  }

  close(): void {
    this.watcher?.close()
    this.fixtureWatcher?.close()
    this.watcher = null
    this.fixtureWatcher = null
  }

  private async loadSource(): Promise<WidgetSource> {
    if (this.isFile) {
      const abs = path.resolve(this.cwd, this.options.source)
      const html = await readFile(abs, 'utf8')
      return {type: 'template', content: html, origin: `file://${abs}`, mimeType: 'text/html;profile=mcp-app'}
    }
    if (!this.options.serverUrl) throw new Error('A ui:// source needs --server <url> to fetch it from')
    const client = new McpClient({serverUrl: this.options.serverUrl, auth: this.options.auth})
    await client.connect()
    try {
      const contents = await client.readResourceRaw(this.options.source)
      const first = contents[0]
      if (!first || typeof first.text !== 'string') throw new Error(`resources/read for ${this.options.source} returned no text`)
      return {type: 'template', content: first.text, origin: this.options.source, mimeType: first.mimeType}
    } finally {
      await client.close()
    }
  }

  private async loadFixture(): Promise<WidgetFixture> {
    if (!this.options.fixturePath) return EMPTY_FIXTURE
    const raw = await readFile(path.resolve(this.cwd, this.options.fixturePath), 'utf8')
    return parseFixture(raw)
  }
}

function debounce(fn: () => void, ms: number): () => void {
  let t: ReturnType<typeof setTimeout> | null = null
  return () => {
    if (t) clearTimeout(t)
    t = setTimeout(fn, ms)
  }
}
