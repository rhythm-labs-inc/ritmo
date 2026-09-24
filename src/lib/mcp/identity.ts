import {ritmoEnv, stateDirectory} from '../naming.js'
/**
 * Host identity `_meta` on tools/call — docs/apps-sdk-contract.md §5.
 *
 * ChatGPT stamps every tools/call with:
 *   openai/subject       anonymised user id, stable across conversations
 *   openai/session       anonymised conversation id
 *   openai/locale        BCP-47 (also openai/userAgent, openai/userLocation, openai/organization)
 *
 * The simulator reproduces this so servers that bind guest sessions to the
 * subject can be exercised, and so the spoofability
 * of the subject can be tested (RHY-88/89): the subject is client-supplied,
 * so a server must never treat it as authorisation.
 *
 * Persistence: the subject is stored per project in `.ritmo/identity.json`
 * (cwd) so `mcp --call` twice, or two simulator runs, look like the SAME user —
 * that is the case that matters for continuity testing. `--new-user` rotates it.
 */

import {randomBytes} from 'node:crypto'
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import path from 'node:path'

export const IDENTITY_DIR = '.ritmo'
export const IDENTITY_FILE = 'identity.json'

export interface HostIdentity {
  subject: string
  session: string
  locale?: string
  organization?: string
}

export interface IdentityFlags {
  /** Pin the subject (not persisted). */
  subject?: string
  /** Rotate to a fresh subject and persist it. */
  newUser?: boolean
  /** Send no identity `_meta` at all (how a host without openai/* behaves). */
  noIdentity?: boolean
  /** Locale to send as openai/locale. */
  locale?: string
}

export function newSubjectId(): string {
  return `ritmo-user-${randomBytes(6).toString('hex')}`
}

export function newSessionId(): string {
  return `ritmo-conv-${randomBytes(6).toString('hex')}`
}

/** Read the persisted subject for a project dir, if any. */
export function readPersistedSubject(dir: string): string | undefined {
  const directory = stateDirectory(dir)
  try {
    const raw = readFileSync(path.join(directory, IDENTITY_FILE), 'utf8')
    const parsed = JSON.parse(raw) as {subject?: unknown}
    return typeof parsed.subject === 'string' && parsed.subject.length > 0 ? parsed.subject : undefined
  } catch {
    return undefined
  }
}

export function persistSubject(dir: string, subject: string): void {
  const d = stateDirectory(dir)
  mkdirSync(d, {recursive: true})
  writeFileSync(path.join(d, IDENTITY_FILE), JSON.stringify({subject, note: 'Ritmo simulated openai/subject — safe to delete; a new one is generated on demand.'}, null, 2) + '\n', 'utf8')
}

/**
 * Resolve the identity for this process from flags + persisted state.
 * Returns `null` when identity should not be sent (`--no-identity`).
 * Precedence: --subject > --new-user > RITMO_SUBJECT env > persisted > new (persisted).
 */
export function resolveIdentity(flags: IdentityFlags, dir: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): HostIdentity | null {
  if (flags.noIdentity) return null

  const envSubject = ritmoEnv('SUBJECT', env)?.trim()
  let subject: string
  if (flags.subject) {
    subject = flags.subject
  } else if (flags.newUser) {
    subject = newSubjectId()
    persistSubject(dir, subject)
  } else if (envSubject) {
    subject = envSubject
  } else {
    const persisted = readPersistedSubject(dir)
    if (persisted) {
      subject = persisted
    } else {
      subject = newSubjectId()
      persistSubject(dir, subject)
    }
  }

  return {subject, session: newSessionId(), locale: flags.locale}
}

/** Build the `_meta` object to send on tools/call. */
export function identityMeta(id: HostIdentity | null | undefined): Record<string, unknown> {
  if (!id) return {}
  const meta: Record<string, unknown> = {
    'openai/subject': id.subject,
    'openai/session': id.session,
  }
  if (id.locale) meta['openai/locale'] = id.locale
  if (id.organization) meta['openai/organization'] = id.organization
  return meta
}

/** New conversation, same user. */
export function rotateSession(id: HostIdentity): HostIdentity {
  return {...id, session: newSessionId()}
}

// ---------------------------------------------------------------------------
// oclif flag helpers (shared by simulate / mcp / test)
// ---------------------------------------------------------------------------

/** Description strings for the identity flags, kept in one place. */
export const IDENTITY_FLAG_DESCRIPTIONS = {
  subject: 'Pin the simulated openai/subject (anonymised user id) for this run; not persisted',
  'new-user': 'Rotate to a fresh openai/subject and persist it in .ritmo/identity.json',
  'no-identity': 'Send no openai/* identity _meta on tools/call (how a non-ChatGPT host behaves)',
  'forge-subject': 'Alias of --subject with a warning: hit the server with a CHOSEN subject to test that it does not trust it as authorisation',
} as const

export interface IdentityFlagValues {
  subject?: string
  'new-user'?: boolean
  'no-identity'?: boolean
  'forge-subject'?: string
}

/** Resolve identity from parsed oclif flags (+ config locale). */
export function identityFromFlags(flags: IdentityFlagValues, locale?: string, dir?: string): HostIdentity | null {
  return resolveIdentity({
    subject: flags['forge-subject'] ?? flags.subject,
    newUser: flags['new-user'],
    noIdentity: flags['no-identity'],
    locale,
  }, dir)
}
