/**
 * Manifest snapshot: everything about an app that OpenAI's review sees
 * (tool descriptors, widget resources + metadata, server info, listing name/subtitle),
 * captured deterministically so it can be committed and diffed.
 *
 * Widget HTML is NOT stored — only its sha256 + byte length — so the file stays
 * small and reviewable; the digest is enough to detect "bytes changed, URI didn't".
 */

import {createHash} from 'node:crypto'

import type {AppRhythmConfig} from '../config-schema.js'
import type {RawResource, RawResourceContent, RawTool} from '../mcp/client.js'
import type {ValidationContext} from '../validate/types.js'

export const MANIFEST_VERSION = 1
export const DEFAULT_MANIFEST_FILE = 'ritmo.manifest.json'

export interface ManifestTool {
  name: string
  /** The raw descriptor with keys sorted recursively. */
  descriptor: RawTool
}

export interface ManifestResource {
  uri: string
  mimeType?: string
  _meta?: Record<string, unknown>
  /** sha256 of the template text (or blob), when readable. */
  sha256?: string
  bytes?: number
  /** Whether resources/list included it (vs only referenced by a tool). */
  listed: boolean
  /** Tools whose descriptors reference this URI. */
  referencedBy: string[]
  readError?: string
}

export interface Manifest {
  version: typeof MANIFEST_VERSION
  capturedAt: string
  serverUrl: string
  tag?: string
  server: {
    name?: string
    version?: string
    protocolVersion?: string
    capabilities: Record<string, unknown>
    instructions?: string
  }
  tools: ManifestTool[]
  resources: ManifestResource[]
  /** Listing metadata from ritmo.yaml, when present. */
  app?: {name: string; subtitle?: string}
}

/** Recursively sort object keys so JSON output is stable across runs. */
export function sortKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(sortKeys) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k])
    }
    return out as T
  }
  return value
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2) + '\n'
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Build a manifest from an already-collected validation context (no extra network). */
export function manifestFromContext(ctx: ValidationContext, opts: {capturedAt: string; tag?: string; config?: AppRhythmConfig} = {capturedAt: new Date().toISOString()}): Manifest {
  const tools: ManifestTool[] = [...ctx.tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({name: t.name, descriptor: sortKeys(t)}))

  const resources: ManifestResource[] = [...ctx.templates.values()]
    .sort((a, b) => a.uri.localeCompare(b.uri))
    .map((t) => resourceEntry(t.uri, t.listed, t.content, t.referencedBy, t.readError))

  const config = opts.config ?? ctx.config
  return {
    version: MANIFEST_VERSION,
    capturedAt: opts.capturedAt,
    serverUrl: ctx.serverUrl,
    ...(opts.tag ? {tag: opts.tag} : {}),
    server: {
      name: ctx.server.name,
      version: ctx.server.version,
      protocolVersion: ctx.server.protocolVersion,
      capabilities: sortKeys(ctx.server.capabilities),
      instructions: ctx.server.instructions,
    },
    tools,
    resources,
    ...(config ? {app: {name: config.app.name, ...(config.app.subtitle ? {subtitle: config.app.subtitle} : {})}} : {}),
  }
}

function resourceEntry(uri: string, listed: RawResource | undefined, content: RawResourceContent | undefined, referencedBy: string[], readError?: string): ManifestResource {
  const meta = (content?._meta ?? listed?._meta) as Record<string, unknown> | undefined
  const mime = content?.mimeType ?? (typeof listed?.mimeType === 'string' ? (listed.mimeType as string) : undefined)
  const body = typeof content?.text === 'string' ? content.text : typeof content?.blob === 'string' ? content.blob : undefined
  return {
    uri,
    ...(mime ? {mimeType: mime} : {}),
    ...(meta ? {_meta: sortKeys(meta)} : {}),
    ...(body !== undefined ? {sha256: sha256(body), bytes: Buffer.byteLength(body, 'utf8')} : {}),
    listed: listed !== undefined,
    referencedBy: [...referencedBy].sort(),
    ...(readError ? {readError} : {}),
  }
}

/** Parse + minimally validate a manifest file's contents. */
export function parseManifest(json: string, source = 'manifest'): Manifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (err) {
    throw new Error(`${source}: not valid JSON (${err instanceof Error ? err.message : String(err)})`, {cause: err})
  }
  const m = parsed as Partial<Manifest>
  if (!m || typeof m !== 'object' || m.version !== MANIFEST_VERSION || !Array.isArray(m.tools) || !Array.isArray(m.resources) || typeof m.server !== 'object') {
    throw new Error(`${source}: not an ritmo manifest (expected version ${MANIFEST_VERSION} with tools/resources/server)`)
  }
  return m as Manifest
}
