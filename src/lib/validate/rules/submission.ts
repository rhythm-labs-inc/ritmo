/**
 * Portal compatibility rules from dated maintainer observations; see docs/apps-sdk-contract.md §8.
 * Contract: docs/apps-sdk-contract.md §1 (transport), §8 (submission portal).
 *
 * Two kinds:
 *  - `transport/*` — raw HTTP probes done in context.ts (`ctx.probes`).
 *  - `submission/*` — checks over the `submission:` / `app:` sections of ritmo.yaml.
 */

import {existsSync, readFileSync, statSync} from 'node:fs'
import path from 'node:path'

import {annotationsOf} from '../meta.js'
import {transportFindings} from '../transport.js'
import type {Finding, Rule, ValidationContext} from '../types.js'

const NAME_MAX = 30
const SUBTITLE_MAX = 30
const POSITIVE_MIN = 5
const NEGATIVE_MIN = 3
const SHOWCASE_MAX = 3
const ICON_SIZE = 1024

const hasConfig = (ctx: ValidationContext) => ctx.config !== undefined
const hasSubmission = (ctx: ValidationContext) => ctx.config?.submission !== undefined

// ---------------------------------------------------------------------------
// transport/*
// ---------------------------------------------------------------------------

export const transportSseGet: Rule = {
  id: 'transport/sse-get',
  hosts: ['chatgpt'],
  description: 'GET on the MCP URL returns text/event-stream (OpenAI\'s tool scanner fails on 405)',
  source: '§1',
  applies: (ctx) => ctx.probes.sseGet !== undefined,
  check(ctx) {
    const p = ctx.probes.sseGet!
    if (p.error) {
      return [{
        rule: this.id, severity: 'warn', target: 'server', source: this.source,
        message: `GET ${p.url} failed: ${p.error}`,
        hint: 'The scanner GETs the MCP URL before POSTing. If this is a local dev server that only speaks POST, expect the portal scan to fail.',
      }]
    }
    const ct = (p.contentType ?? '').toLowerCase()
    if (p.status && p.status >= 200 && p.status < 300 && ct.includes('text/event-stream')) return []
    if (p.status === 405) {
      return [{
        rule: this.id, severity: 'fail', target: 'server', source: this.source,
        message: 'GET returns 405 Method Not Allowed',
        hint: 'Spec-legal, but OpenAI\'s tool scanner fails the scan on it. Answer GET with a `text/event-stream` response (a single comment frame then close is enough). Dated maintainer observation (docs/apps-sdk-contract.md §1).',
      }]
    }
    return [{
      rule: this.id, severity: 'fail', target: 'server', source: this.source,
      message: `GET returns ${p.status ?? '?'} ${ct ? `(${ct})` : ''}; expected 2xx text/event-stream`,
      hint: 'Return `Content-Type: text/event-stream` with a 200 for GET on the MCP endpoint.',
    }]
  },
}

export const transportChallenge: Rule = {
  id: 'transport/domain-challenge',
  hosts: ['chatgpt'],
  description: 'https://<host>/.well-known/openai-apps-challenge serves exactly the configured token',
  source: '§8',
  applies: (ctx) => ctx.probes.challenge !== undefined,
  check(ctx) {
    const p = ctx.probes.challenge!
    const token = ctx.config?.submission?.challenge_token
    if (p.error) {
      return [{
        rule: this.id, severity: 'fail', target: p.url, source: this.source,
        message: `challenge URL unreachable: ${p.error}`,
        hint: 'The portal verifies domain ownership by fetching this URL. Serve the token over HTTPS on the challenge host.',
      }]
    }
    if (p.status !== 200) {
      return [{
        rule: this.id, severity: 'fail', target: p.url, source: this.source,
        message: `challenge URL returned ${p.status}`,
        hint: 'Must be a 200 whose body is only the verification token.',
      }]
    }
    const body = (p.bodyPreview ?? '').trim()
    if (token && body !== token) {
      const looksJson = body.startsWith('{') || body.startsWith('[')
      return [{
        rule: this.id, severity: 'fail', target: p.url, source: this.source,
        message: looksJson ? 'challenge body is JSON; the portal expects the bare token' : 'challenge body does not equal the configured token',
        hint: 'Return only the token string — no JSON, no list, no whitespace decoration.',
      }]
    }
    return []
  },
}

// ---------------------------------------------------------------------------
// submission/* — listing metadata
// ---------------------------------------------------------------------------

export const submissionListing: Rule = {
  id: 'submission/listing',
  hosts: ['chatgpt'],
  description: `Listing metadata: name ≤ ${NAME_MAX}, subtitle ≤ ${SUBTITLE_MAX}, description, privacy policy, and terms URLs`,
  source: '§8',
  applies: hasConfig,
  check(ctx) {
    const out: Finding[] = []
    const app = ctx.config!.app
    if (app.name.length > NAME_MAX) {
      out.push({
        rule: this.id, severity: 'fail', target: 'app.name', source: this.source,
        message: `"${app.name}" is ${app.name.length} chars; the portal enforces ≤ ${NAME_MAX}`,
        hint: 'Rhythm lost its "… for ChatGPT" suffix to this limit. Shorten the name.',
      })
    }
    if (app.subtitle === undefined) {
      out.push({
        rule: this.id, severity: 'warn', target: 'app.subtitle', source: this.source,
        message: 'no subtitle',
        hint: `Add app.subtitle (≤ ${SUBTITLE_MAX} chars); the portal form requires one.`,
      })
    } else if (app.subtitle.length > SUBTITLE_MAX) {
      out.push({
        rule: this.id, severity: 'fail', target: 'app.subtitle', source: this.source,
        message: `subtitle is ${app.subtitle.length} chars; the portal enforces ≤ ${SUBTITLE_MAX}`,
      })
    }
    if (app.description.length < 40) {
      out.push({
        rule: this.id, severity: 'info', target: 'app.description', source: this.source,
        message: 'description is short; the listing description is what users read on the app page',
      })
    }
    if (!app.privacy_policy_url) {
      out.push({
        rule: this.id, severity: 'fail', target: 'app.privacy_policy_url', source: this.source,
        message: 'no privacy policy URL',
        hint: 'Required by the portal (and by the Claude directory). Add app.privacy_policy_url (https).',
      })
    }
    if (!app.terms_url) {
      out.push({
        rule: this.id, severity: 'fail', target: 'app.terms_url', source: this.source,
        message: 'no terms URL',
        hint: 'The submission material requires a public terms URL that matches the publisher. Add app.terms_url (https).',
      })
    }
    if (!app.company_url && !app.support_url) {
      out.push({
        rule: this.id, severity: 'warn', target: 'app.company_url', source: this.source,
        message: 'no company or support URL',
        hint: 'The portal asks for website + support URLs; add app.company_url and/or app.support_url.',
      })
    }
    return out
  },
}

export const submissionIcon: Rule = {
  id: 'submission/icon',
  hosts: ['chatgpt'],
  description: `App icon exists and is a ${ICON_SIZE}×${ICON_SIZE} PNG`,
  source: '§8',
  applies: hasConfig,
  check(ctx) {
    const icon = ctx.config!.app.icon
    const abs = path.resolve(process.cwd(), icon)
    if (!existsSync(abs)) {
      return [{
        rule: this.id, severity: 'warn', target: 'app.icon', source: this.source,
        message: `icon file not found: ${icon}`,
        hint: `Point app.icon at a ${ICON_SIZE}×${ICON_SIZE} PNG with a solid background (circle-crop safe).`,
      }]
    }
    const dims = pngDimensions(abs)
    if (!dims) {
      return [{
        rule: this.id, severity: 'warn', target: 'app.icon', source: this.source,
        message: 'icon is not a PNG (or the header is unreadable)',
        hint: 'The portal expects a PNG.',
      }]
    }
    if (dims.width !== ICON_SIZE || dims.height !== ICON_SIZE) {
      return [{
        rule: this.id, severity: 'warn', target: 'app.icon', source: this.source,
        message: `icon is ${dims.width}×${dims.height}; expected ${ICON_SIZE}×${ICON_SIZE}`,
      }]
    }
    return []
  },
}

// ---------------------------------------------------------------------------
// submission/* — package content
// ---------------------------------------------------------------------------

export const submissionTestCases: Rule = {
  id: 'submission/test-cases',
  hosts: ['chatgpt'],
  description: `≥ ${POSITIVE_MIN} positive and ≥ ${NEGATIVE_MIN} negative test cases with the fields the portal form asks for`,
  source: '§8',
  applies: hasConfig,
  check(ctx) {
    const out: Finding[] = []
    const sub = ctx.config!.submission
    const pos = sub?.test_cases ?? []
    const neg = sub?.negative_test_cases ?? []
    if (pos.length < POSITIVE_MIN) {
      out.push({
        rule: this.id, severity: 'fail', target: 'submission.test_cases', source: this.source,
        message: `${pos.length} positive test case${pos.length === 1 ? '' : 's'}; the portal requires at least ${POSITIVE_MIN}`,
        hint: 'Each needs scenario, prompt, tools (expected to trigger), expected (result shape). Author them in ritmo.yaml → submission.test_cases; `package` emits them.',
      })
    } else if (pos.length > POSITIVE_MIN) {
      out.push({
        rule: this.id, severity: 'info', target: 'submission.test_cases', source: this.source,
        message: `${pos.length} positive test cases; the July 2026 portal form had exactly ${POSITIVE_MIN} slots (docs now say "at least")`,
      })
    }
    if (neg.length < NEGATIVE_MIN) {
      out.push({
        rule: this.id, severity: 'fail', target: 'submission.negative_test_cases', source: this.source,
        message: `${neg.length} negative test case${neg.length === 1 ? '' : 's'}; the portal requires at least ${NEGATIVE_MIN}`,
        hint: 'Each needs scenario, prompt (where the app must NOT trigger), rationale.',
      })
    } else if (neg.length > NEGATIVE_MIN) {
      out.push({
        rule: this.id, severity: 'info', target: 'submission.negative_test_cases', source: this.source,
        message: `${neg.length} negative test cases; the July 2026 portal form had exactly ${NEGATIVE_MIN} slots`,
      })
    }
    // Referenced tools must exist on the server
    const names = new Set(ctx.tools.map((t) => t.name))
    for (const [i, tc] of pos.entries()) {
      for (const tool of tc.tools) {
        if (!names.has(tool)) {
          out.push({
            rule: this.id, severity: 'fail', target: `submission.test_cases[${i}]`, source: this.source,
            message: `references tool "${tool}" which the server does not expose`,
          })
        }
      }
    }
    return out
  },
}

export const submissionShowcase: Rule = {
  id: 'submission/showcase-prompts',
  hosts: ['chatgpt'],
  description: `1–${SHOWCASE_MAX} showcase prompts (shown on the app page; ChatGPT prepends the app mention)`,
  source: '§8',
  applies: hasConfig,
  check(ctx) {
    const prompts = ctx.config!.submission?.showcase_prompts ?? []
    if (prompts.length === 0) {
      return [{
        rule: this.id, severity: 'warn', target: 'submission.showcase_prompts', source: this.source,
        message: 'no showcase prompts',
        hint: `Add up to ${SHOWCASE_MAX} under submission.showcase_prompts — specific enough to show when to use the app, general enough to adapt.`,
      }]
    }
    if (prompts.length > SHOWCASE_MAX) {
      return [{
        rule: this.id, severity: 'fail', target: 'submission.showcase_prompts', source: this.source,
        message: `${prompts.length} showcase prompts; the portal accepts at most ${SHOWCASE_MAX}`,
      }]
    }
    return []
  },
}

export const submissionJustifications: Rule = {
  id: 'submission/annotation-justifications',
  hosts: ['chatgpt'],
  description: 'A written justification per tool per annotation (the portal form requires them)',
  source: '§8',
  applies: hasSubmission,
  check(ctx) {
    const out: Finding[] = []
    const cfgTools = ctx.config!.submission!.tools
    for (const t of ctx.tools) {
      const a = annotationsOf(t)
      const j = cfgTools[t.name]?.justifications ?? {}
      const missing = (['readOnlyHint', 'destructiveHint', 'openWorldHint'] as const)
        .filter((k) => typeof a[k] === 'boolean' && !j[k])
      if (missing.length > 0) {
        out.push({
          rule: this.id, severity: 'warn', target: t.name, source: this.source,
          message: `no justification for ${missing.join(', ')}`,
          hint: `Add submission.tools.${t.name}.justifications.{${missing.join(',')}} so the form can be filled from the repo.`,
        })
      }
    }
    for (const name of Object.keys(cfgTools)) {
      if (!ctx.tools.some((t) => t.name === name)) {
        out.push({
          rule: this.id, severity: 'info', target: name, source: this.source,
          message: 'submission.tools entry for a tool the server does not expose',
        })
      }
    }
    return out
  },
}

/** Local skill-tree checks plus explicit guidance for submission-time MCP imports. */
export const submissionSkills: Rule = {
  id: 'submission/skills',
  hosts: ['chatgpt'],
  description: 'Configured skills have a local SKILL.md tree; MCP-imported skills require a portal re-scan',
  source: '§8',
  applies: hasSubmission,
  check(ctx) {
    const out: Finding[] = []
    const skills = ctx.config!.submission!.skills
    const names = new Set<string>()
    for (const skill of skills) {
      if (names.has(skill.name)) {
        out.push({
          rule: this.id, severity: 'fail', target: `submission.skills.${skill.name}`, source: this.source,
          message: 'duplicate skill name',
          hint: 'Use one unique name per submitted skill so the package and portal snapshot are unambiguous.',
        })
      }
      names.add(skill.name)
      const sourcePath = path.resolve(process.cwd(), skill.path)
      if (!existsSync(sourcePath) || !statSync(sourcePath).isDirectory()) {
        out.push({
          rule: this.id, severity: 'fail', target: `submission.skills.${skill.name}.path`, source: this.source,
          message: `skill directory not found: ${skill.path}`,
          hint: 'Point path at the tested local skill directory containing SKILL.md.',
        })
        continue
      }
      if (!existsSync(path.join(sourcePath, 'SKILL.md'))) {
        out.push({
          rule: this.id, severity: 'fail', target: `submission.skills.${skill.name}.path`, source: this.source,
          message: `SKILL.md not found in ${skill.path}`,
          hint: 'Every submitted skill needs the same tested SKILL.md tree you will upload or import.',
        })
      }
      if (skill.delivery === 'mcp-import') {
        out.push({
          rule: this.id, severity: 'info', target: skill.name, source: this.source,
          message: 'MCP-imported skill is a submission-time snapshot',
          hint: 'Ritmo cannot prove which static skills the portal imported. Select Scan Tools again after a server skill changes, then review the imported snapshot in the portal.',
        })
      }
    }
    return out
  },
}

export const submissionAvailability: Rule = {
  id: 'submission/country-availability',
  hosts: ['chatgpt'],
  description: 'At least one country is selected for the plugin Global tab',
  source: '§8',
  applies: hasConfig,
  check(ctx) {
    const countries = ctx.config!.submission?.country_availability ?? []
    if (countries.length > 0) return []
    return [{
      rule: this.id, severity: 'warn', target: 'submission.country_availability', source: this.source,
      message: 'no country availability selected',
      hint: 'Select only countries where the publisher, product, support process, and legal terms are ready for users. Record ISO alpha-2 codes here before filling the Global tab.',
    }]
  },
}

export const submissionAttestations: Rule = {
  id: 'submission/policy-attestations',
  hosts: ['chatgpt'],
  description: 'A named human has recorded the final portal policy-attestation confirmation',
  source: '§8',
  applies: hasConfig,
  check(ctx) {
    const attestation = ctx.config!.submission?.policy_attestations
    if (!attestation?.confirmed) {
      return [{
        rule: this.id, severity: 'warn', target: 'submission.policy_attestations', source: this.source,
        message: 'policy attestations not confirmed',
        hint: 'After checking the listing, server, skills, prompts, tests, and availability, record the responsible person and timestamp. This records a human decision; it does not certify policy compliance.',
      }]
    }
    const missing = [
      !attestation.confirmed_by && 'confirmed_by',
      !attestation.confirmed_at && 'confirmed_at',
    ].filter(Boolean)
    if (missing.length === 0) return []
    return [{
      rule: this.id, severity: 'warn', target: 'submission.policy_attestations', source: this.source,
      message: `confirmation missing ${missing.join(', ')}`,
      hint: 'Record who made the human confirmation and an ISO-8601 timestamp.',
    }]
  },
}

export const submissionReleaseNotes: Rule = {
  id: 'submission/release-notes',
  hosts: ['chatgpt'],
  description: 'Release notes state submission kind, summary, changes, and reviewer setup',
  source: '§8',
  applies: hasConfig,
  check(ctx) {
    if (ctx.config!.submission?.release_notes) return []
    return [{
      rule: this.id, severity: 'warn', target: 'submission.release_notes', source: this.source,
      message: 'release notes missing',
      hint: 'Describe what the plugin does, whether this is an initial submission or update, changes since the prior submission, and reviewer credentials/data/setup notes.',
    }]
  },
}

/** Deep transport findings (initialize/protocol/CORS/DELETE/Origin/body/error-hygiene/rate-limit) as one rule. */
export const transportDeep: Rule = {
  id: 'transport/deep',
  description: 'Deep transport probes: initialize, protocol negotiation, CORS preflight, DELETE, Origin allow-list, body bounds, error hygiene (and --hammer)',
  source: '§1',
  applies: (ctx) => ctx.probes.transport !== undefined,
  check(ctx) {
    // Reuse the doctor's pure findings; sse-get and templates are covered by their own validate rules.
    return transportFindings(ctx.probes.transport!).filter((f) => f.rule !== 'transport/sse-get' && f.rule !== 'transport/templates' && f.severity !== 'pass')
  },
}

export const TRANSPORT_RULES: Rule[] = [transportSseGet, transportChallenge, transportDeep]

export const SUBMISSION_RULES: Rule[] = [
  submissionListing,
  submissionIcon,
  submissionTestCases,
  submissionShowcase,
  submissionJustifications,
  submissionSkills,
  submissionAvailability,
  submissionAttestations,
  submissionReleaseNotes,
]

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Read width/height from a PNG IHDR chunk. Returns undefined if not a PNG. */
export function pngDimensions(file: string): {width: number; height: number} | undefined {
  try {
    const buf = readFileSync(file)
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    if (buf.length < 24 || !buf.subarray(0, 8).equals(sig)) return undefined
    return {width: buf.readUInt32BE(16), height: buf.readUInt32BE(20)}
  } catch {
    return undefined
  }
}
