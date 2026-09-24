/**
 * "Since last snapshot" — compares the live server to the committed manifest
 * (apprhythm.manifest.json) and reports what would need OpenAI re-review.
 * Classification lives in src/lib/manifest/diff.ts.
 */

import {diffManifests} from '../../manifest/diff.js'
import {manifestFromContext} from '../../manifest/snapshot.js'
import type {Finding, Rule} from '../types.js'

export const manifestSinceSnapshot: Rule = {
  id: 'manifest/since-snapshot',
  description: 'Changes since the committed manifest snapshot that require OpenAI resubmission',
  source: '§3',
  applies: (ctx) => ctx.previousManifest !== undefined,
  check(ctx) {
    const live = manifestFromContext(ctx, {capturedAt: 'live'})
    const changes = diffManifests(ctx.previousManifest!, live)
    const out: Finding[] = []
    for (const c of changes) {
      if (c.class === 'resubmit') {
        out.push({
          rule: this.id, severity: 'warn', target: c.path, source: this.source,
          message: `${c.message} — requires resubmission (${c.rule})`,
          hint: 'The listed app will not see this until OpenAI re-reviews. Run `ritmo manifest diff` for the full picture; re-snapshot after submitting.',
        })
      } else if (c.class === 'warn') {
        out.push({rule: this.id, severity: 'warn', target: c.path, source: this.source, message: `${c.message} (${c.rule})`})
      }
    }
    return out
  },
}

export const MANIFEST_RULES: Rule[] = [manifestSinceSnapshot]
