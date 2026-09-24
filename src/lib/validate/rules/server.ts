/**
 * Server-level and local-config rules. Contract: docs/apps-sdk-contract.md §1, §8.
 */

import type {Finding, Rule} from '../types.js'

export const serverInstructions: Rule = {
  id: 'server/instructions',
  description: 'Server returns `instructions` at initialize',
  source: '§1',
  check(ctx) {
    const i = ctx.server.instructions
    if (typeof i === 'string' && i.trim().length > 0) return []
    return [{
      rule: this.id, severity: 'warn', target: 'server', source: this.source,
      message: 'no server instructions returned at initialize',
      hint: 'ChatGPT reads server-level `instructions` and applies them across tools — a major discovery/behaviour lever. Return them from initialize.',
    }]
  },
}

export const serverResourcesCapability: Rule = {
  id: 'server/resources-capability',
  description: 'Servers that reference ui:// templates advertise the resources capability',
  source: '§3',
  check(ctx) {
    const referenced = [...ctx.templates.values()].filter((t) => t.referencedBy.length > 0)
    if (referenced.length === 0 || ctx.resources !== null) return []
    return [{
      rule: this.id, severity: 'fail', target: 'server', source: this.source,
      message: `${referenced.length} tool(s) reference ui:// templates but the server does not advertise the resources capability`,
      hint: 'Add `resources: {}` to server capabilities and implement resources/list + resources/read.',
    }]
  },
}

export const serverHasTools: Rule = {
  id: 'server/has-tools',
  description: 'tools/list returns at least one tool',
  source: '§2',
  check(ctx) {
    if (ctx.tools.length > 0) return []
    return [{
      rule: this.id, severity: 'fail', target: 'server', source: this.source,
      message: 'server exposes no tools',
    }]
  },
}

export const configScreenshots: Rule = {
  id: 'config/screenshots',
  description: 'ritmo.yaml lists at least 3 screenshots for the listing',
  source: '§8',
  applies: (ctx) => ctx.config !== undefined,
  check(ctx) {
    if (!ctx.config) return []
    const n = ctx.config.app.screenshots.length
    if (n >= 3) return []
    return [{
      rule: this.id, severity: 'warn', target: 'config', source: this.source,
      message: `app.screenshots has ${n} entr${n === 1 ? 'y' : 'ies'}; the listing expects at least 3`,
      hint: 'Add screenshot paths under app.screenshots in ritmo.yaml (submission concern only; local simulation doesn\'t need them).',
    }]
  },
}

export const SERVER_RULES: Rule[] = [
  serverHasTools,
  serverInstructions,
  serverResourcesCapability,
]

export const CONFIG_RULES: Rule[] = [
  configScreenshots,
]

// Re-export the Finding type for rule authors' convenience.
export type {Finding}
