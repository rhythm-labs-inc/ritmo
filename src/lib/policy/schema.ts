import {createHash} from 'node:crypto'

import {z, ZodError} from 'zod'

export const POLICY_BUNDLE_SCHEMA_VERSION = 1

const id = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/, 'must start with a lowercase letter and use lowercase letters, numbers, or hyphens')
const ruleId = z.string().regex(/^[a-z][a-z0-9/_-]{0,127}$/, 'must use lowercase letters, numbers, slashes, underscores, or hyphens')
const nonEmpty = z.string().trim().min(1, 'must not be empty')
const timestamp = z.string().datetime({offset: true})

const policyRuleSchema = z.object({
  id: ruleId,
  description: nonEmpty,
  source: z.object({
    reference: nonEmpty,
    verified_at: timestamp,
    confidence: z.enum(['verified', 'inferred', 'unverified']),
  }).strict(),
  applicability: z.object({
    hosts: z.array(z.enum(['chatgpt', 'mcp-apps'])).min(1).default(['chatgpt', 'mcp-apps']),
    blueprint_fields: z.array(nonEmpty).min(1),
  }).strict(),
  implementation: z.object({
    rule_id: ruleId.optional(),
    version: nonEmpty,
  }).strict(),
  uncertainty: nonEmpty.optional(),
}).strict().superRefine((rule, context) => {
  if (rule.source.confidence !== 'verified' && !rule.uncertainty) {
    context.addIssue({code: z.ZodIssueCode.custom, path: ['uncertainty'], message: 'is required when source confidence is inferred or unverified'})
  }
})

export const policyBundleSchema = z.object({
  schema_version: z.literal(POLICY_BUNDLE_SCHEMA_VERSION, {errorMap: () => ({message: `schema_version must be ${POLICY_BUNDLE_SCHEMA_VERSION}`})}),
  id,
  version: nonEmpty,
  verified_at: timestamp,
  rules: z.array(policyRuleSchema).min(1, 'must contain at least one policy rule'),
  sha256: z.string().regex(/^[a-f0-9]{64}$/, 'must be a lowercase SHA-256 digest'),
}).strict().superRefine((bundle, context) => {
  const duplicates = bundle.rules.map((rule) => rule.id).filter((id, index, all) => all.indexOf(id) !== index)
  if (duplicates.length > 0) {
    context.addIssue({code: z.ZodIssueCode.custom, path: ['rules'], message: `contains duplicate rule ids: ${[...new Set(duplicates)].join(', ')}`})
  }
  if (bundle.sha256 !== bundleSha256(bundle)) {
    context.addIssue({code: z.ZodIssueCode.custom, path: ['sha256'], message: 'does not match the canonical bundle content'})
  }
})

export type PolicyBundle = z.infer<typeof policyBundleSchema>
export type PolicyRule = z.infer<typeof policyRuleSchema>
export type PolicyBundleInput = Omit<PolicyBundle, 'sha256'>

export class PolicyBundleValidationError extends Error {
  constructor(public readonly issues: Array<{path: string; message: string}>) {
    super(`Invalid policy bundle (${issues.length} error${issues.length === 1 ? '' : 's'}): ${issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`)
    this.name = 'PolicyBundleValidationError'
  }
}

/** Create a content-addressed, strict policy bundle. */
export function createPolicyBundle(input: PolicyBundleInput): PolicyBundle {
  const sha256 = bundleSha256(input)
  return validatePolicyBundle({...input, sha256})
}

export function validatePolicyBundle(value: unknown): PolicyBundle {
  const result = policyBundleSchema.safeParse(value)
  if (result.success) return result.data
  throw new PolicyBundleValidationError(formatIssues(result.error))
}

/** SHA-256 over canonical content excluding the derived digest field. */
export function bundleSha256(bundle: Omit<PolicyBundle, 'sha256'> | PolicyBundle): string {
  const {sha256: _sha256, ...content} = bundle as PolicyBundle
  return createHash('sha256').update(canonicalJson(content), 'utf8').digest('hex')
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function formatIssues(error: ZodError): Array<{path: string; message: string}> {
  return error.issues.map((issue) => ({path: issue.path.length > 0 ? issue.path.join('.') : '(root)', message: issue.message}))
}
