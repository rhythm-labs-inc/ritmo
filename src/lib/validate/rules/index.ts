import type {Rule} from '../types.js'
import {CONTRACT_RUNTIME_RULES, CONTRACT_STATIC_RULES} from './contract.js'
import {DIRECTORY_RULES} from './directory.js'
import {MANIFEST_RULES} from './manifest.js'
import {CONFIG_RULES, SERVER_RULES} from './server.js'
import {SUBMISSION_RULES, TRANSPORT_RULES} from './submission.js'
import {TOOL_RULES} from './tools.js'
import {WIDGET_RULES} from './widgets.js'
import {RESOURCE_ENVELOPE_RULES} from './resource-envelope.js'

/** All rules, in report order. */
export const ALL_RULES: Rule[] = [
  ...SERVER_RULES,
  ...TRANSPORT_RULES,
  ...TOOL_RULES,
  ...WIDGET_RULES,
  ...RESOURCE_ENVELOPE_RULES,
  ...CONTRACT_STATIC_RULES,
  ...CONTRACT_RUNTIME_RULES,
  ...CONFIG_RULES,
  ...SUBMISSION_RULES,
  ...DIRECTORY_RULES,
  ...MANIFEST_RULES,
]

export function findRule(id: string): Rule | undefined {
  return ALL_RULES.find((r) => r.id === id)
}
