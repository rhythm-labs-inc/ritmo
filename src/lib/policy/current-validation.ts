import {ALL_RULES} from '../validate/rules/index.js'
import type {ValidationPolicyInfo} from '../validate/types.js'

import {createPolicyBundle, type PolicyBundle} from './schema.js'

const VERIFIED_AT = '2026-08-27T00:00:00.000Z'

/**
 * Migrates the provenance already attached to every validation rule into a
 * versioned policy bundle. Rule behavior remains the existing pure validator;
 * this bundle makes its source, version, applicability, and confidence explicit.
 */
export function currentValidationPolicyBundle(): PolicyBundle {
  return createPolicyBundle({
    schema_version: 1,
    id: 'apprhythm-validation',
    version: '1.2.0',
    verified_at: '2026-09-12T00:00:00.000Z',
    rules: ALL_RULES.map((rule) => ({
      id: rule.id,
      description: rule.description,
      source: {
        reference: `docs/apps-sdk-contract.md ${rule.source}`,
        verified_at: rule.id.startsWith('resource/cache-') || rule.id.startsWith('manifest/') ? '2026-09-12T00:00:00.000Z' : VERIFIED_AT,
        confidence: rule.id.startsWith('resource/cache-') || rule.id === 'tool/description' ? 'inferred' : rule.source.includes('[unverified]') ? 'unverified' : 'verified',
      },
      applicability: {
        hosts: rule.hosts ?? ['chatgpt', 'mcp-apps'],
        blueprint_fields: fieldsForRule(rule.id),
      },
      implementation: {rule_id: rule.id, version: rule.id.startsWith('manifest/') || ['tool/description', 'tool/annotations-present', 'tool/security-schemes', 'tool/output-schema', 'directory/listing'].includes(rule.id) ? '2' : '1'},
      ...(rule.id.startsWith('resource/cache-') ? {uncertainty: 'ChatGPT compatibility is based on the dated RHY-277 observation; its failing negotiation was not captured. Draft presence requirements are not imposed on portable stable versions.'} : {}),
      ...(rule.id === 'tool/description' ? {uncertainty: 'Text-pattern guidance is a heuristic and cannot establish semantic completeness.'} : {}),
      ...(rule.source.includes('[unverified]') ? {uncertainty: 'The existing validation rule is explicitly marked unverified in its source contract.'} : {}),
    })),
  })
}

export function validationPolicyInfo(bundle: PolicyBundle): ValidationPolicyInfo {
  return {
    bundleId: bundle.id,
    bundleVersion: bundle.version,
    bundleSha256: bundle.sha256,
    rules: bundle.rules
      .filter((rule) => rule.implementation.rule_id !== undefined)
      .map((rule) => ({id: rule.id, implementationVersion: rule.implementation.version}))
      .sort((left, right) => left.id.localeCompare(right.id)),
  }
}

function fieldsForRule(ruleId: string): string[] {
  if (ruleId.startsWith('submission/') || ruleId.startsWith('config/')) return ['review_evidence', 'product_contract']
  if (ruleId.startsWith('directory/')) return ['product_contract.supported_hosts', 'review_evidence']
  if (ruleId.startsWith('transport/') || ruleId.startsWith('server/')) return ['delivery.environments', 'product_contract']
  if (ruleId.startsWith('contract/')) return ['product_contract.tools', 'quality.contract_checks']
  if (ruleId.startsWith('widget/') || ruleId.startsWith('resource/')) return ['product_contract.ui_resources']
  if (ruleId.startsWith('manifest/')) return ['product_contract', 'review_evidence']
  return ['product_contract']
}
