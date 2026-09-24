import type {PluginBlueprintV1} from '../blueprint/schema.js'

import {canonicalJson, type PolicyBundle} from './schema.js'

export interface PolicyRuleChange {
  ruleId: string
  kind: 'added' | 'changed' | 'removed'
  affectedFields: string[]
}

export interface AffectedBlueprint {
  blueprint: {id: string; revision: string}
  rules: PolicyRuleChange[]
  fields: string[]
}

/** Compare bundle content, excluding only the bundle's derived SHA-256. */
export function diffPolicyBundles(before: PolicyBundle, after: PolicyBundle): PolicyRuleChange[] {
  const beforeById = new Map(before.rules.map((rule) => [rule.id, rule]))
  const afterById = new Map(after.rules.map((rule) => [rule.id, rule]))
  const ids = [...new Set([...beforeById.keys(), ...afterById.keys()])].sort()

  const changes: PolicyRuleChange[] = []
  for (const id of ids) {
    const previous = beforeById.get(id)
    const next = afterById.get(id)
    if (!previous && next) {
      changes.push({ruleId: id, kind: 'added', affectedFields: next.applicability.blueprint_fields})
      continue
    }
    if (previous && !next) {
      changes.push({ruleId: id, kind: 'removed', affectedFields: previous.applicability.blueprint_fields})
      continue
    }
    if (previous && next && canonicalJson(previous) !== canonicalJson(next)) {
      changes.push({ruleId: id, kind: 'changed', affectedFields: [...new Set([...previous.applicability.blueprint_fields, ...next.applicability.blueprint_fields])].sort()})
    }
  }
  return changes
}

/** Report Blueprint revisions that declare a policy rule changed by a bundle update. */
export function affectedBlueprints(changes: PolicyRuleChange[], blueprints: PluginBlueprintV1[]): AffectedBlueprint[] {
  const changesById = new Map(changes.map((change) => [change.ruleId, change]))
  return blueprints.flatMap((blueprint) => {
    const rules = blueprint.policy_provenance.rules
      .map((rule) => changesById.get(rule.id))
      .filter((change): change is PolicyRuleChange => change !== undefined)
    if (rules.length === 0) return []
    return [{
      blueprint: {id: blueprint.id, revision: blueprint.revision},
      rules,
      fields: [...new Set(rules.flatMap((rule) => rule.affectedFields))].sort(),
    }]
  })
}
