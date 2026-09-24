import {z, ZodError} from 'zod'

import {BlueprintValidationError, type BlueprintValidationIssue} from './errors.js'

export const BLUEPRINT_SCHEMA_VERSION = 1

export type JsonPrimitive = boolean | null | number | string
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
export interface JsonObject {
  [key: string]: JsonValue
}

const identifier = z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/, 'must start with a lowercase letter and use lowercase letters, numbers, underscores, or hyphens')
const policyRuleId = z.string().regex(/^[a-z][a-z0-9/_-]{0,127}$/, 'must use lowercase letters, numbers, slashes, underscores, or hyphens')
const nonEmpty = z.string().trim().min(1, 'must not be empty')
const isoTimestamp = z.string().datetime({offset: true})
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO-8601 date')

const httpUrl = z.string().url('must be a valid URL').superRefine((value, context) => {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      context.addIssue({code: z.ZodIssueCode.custom, message: 'must use http:// or https://'})
    }
    if (url.username || url.password) {
      context.addIssue({code: z.ZodIssueCode.custom, message: 'must not include credentials'})
    }
  } catch {
    // z.string().url() provides the format issue.
  }
})

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(jsonValueSchema),
]))

const jsonObjectSchema: z.ZodType<JsonObject> = z.record(jsonValueSchema)

const credentialReferenceSchema = z.object({
  kind: z.enum(['environment', 'keychain', 'secret-manager', 'short-lived-handle']),
  locator: nonEmpty.max(512),
}).strict().superRefine(({kind, locator}, context) => {
  if (kind === 'environment' && !/^[A-Z][A-Z0-9_]*$/.test(locator)) {
    context.addIssue({code: z.ZodIssueCode.custom, path: ['locator'], message: 'environment locator must be an uppercase environment-variable name'})
  }

  if (kind === 'secret-manager' && !/^[a-z][a-z0-9+.-]*:\/\/.+/.test(locator)) {
    context.addIssue({code: z.ZodIssueCode.custom, path: ['locator'], message: 'secret-manager locator must be a URI reference, not a secret value'})
  }

  if (/^(?:sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{16,})$/.test(locator)) {
    context.addIssue({code: z.ZodIssueCode.custom, path: ['locator'], message: 'credential reference must not contain a raw secret value'})
  }
})

const intentSchema = z.object({
  owner: z.object({
    name: nonEmpty,
    kind: z.enum(['individual', 'organization', 'team']),
    contact: z.string().email('must be a valid email address').optional(),
  }).strict(),
  audience: z.array(nonEmpty).min(1, 'must contain at least one audience'),
  use_cases: z.array(z.object({
    id: identifier,
    description: nonEmpty,
    success_measure: nonEmpty,
  }).strict()).min(1, 'must contain at least one use case'),
  business_model: z.object({
    model: z.enum(['free', 'subscription', 'usage-based', 'services', 'internal', 'other']),
    description: nonEmpty,
  }).strict(),
  exclusions: z.array(nonEmpty).min(1, 'must contain at least one explicit exclusion'),
}).strict()

const productContractSchema = z.object({
  tools: z.array(z.object({
    name: identifier,
    title: nonEmpty.optional(),
    description: nonEmpty,
    input_schema: jsonObjectSchema,
    output_schema: jsonObjectSchema.optional(),
    annotations: jsonObjectSchema.optional(),
  }).strict()).min(1, 'must contain at least one tool'),
  ui_resources: z.array(z.object({
    uri: nonEmpty,
    description: nonEmpty.optional(),
    mime_type: nonEmpty.optional(),
  }).strict()).default([]),
  skills: z.array(z.object({
    name: identifier,
    source: nonEmpty,
  }).strict()).default([]),
  supported_hosts: z.array(z.enum(['chatgpt', 'mcp-apps'])).min(1, 'must contain at least one supported host'),
}).strict()

const dataSecuritySchema = z.object({
  data_classification: z.array(z.enum(['public', 'internal', 'confidential', 'restricted'])).min(1, 'must classify data'),
  integrations: z.array(z.object({
    id: identifier,
    kind: z.enum(['api', 'database', 'dataset', 'website', 'identity-provider', 'other']),
    description: nonEmpty,
    credential_references: z.array(credentialReferenceSchema).default([]),
  }).strict()).default([]),
  permissions: z.array(z.object({
    id: identifier,
    description: nonEmpty,
  }).strict()).default([]),
  sensitive_actions: z.array(z.object({
    id: identifier,
    description: nonEmpty,
    requires_confirmation: z.boolean(),
  }).strict()).default([]),
  egress_boundaries: z.array(z.object({
    destination: httpUrl,
    purpose: nonEmpty,
  }).strict()).default([]),
}).strict()

const identitySchema = z.object({
  authentication: z.object({
    pattern: z.enum(['none', 'api-key', 'oauth', 'session', 'custom']),
    credential_references: z.array(credentialReferenceSchema).default([]),
  }).strict(),
  scopes: z.array(nonEmpty).default([]),
  entitlement_model: nonEmpty,
  test_accounts: z.array(z.object({
    id: identifier,
    account_state: nonEmpty,
    credential_reference: credentialReferenceSchema.optional(),
  }).strict()).default([]),
  account_states: z.array(nonEmpty).min(1, 'must contain at least one account state'),
}).strict().superRefine(({authentication}, context) => {
  if (authentication.pattern === 'none' && authentication.credential_references.length > 0) {
    context.addIssue({code: z.ZodIssueCode.custom, path: ['authentication', 'credential_references'], message: 'must be empty when authentication.pattern is none'})
  }
})

const qualitySchema = z.object({
  evaluation: z.object({
    model: nonEmpty,
    locale: nonEmpty,
    timezone: nonEmpty,
  }).strict(),
  interaction_tests: z.array(z.object({
    id: identifier,
    class: z.enum(['direct', 'indirect', 'negative', 'multi-turn', 'identity', 'contract', 'golden-prompt']),
    prompt: nonEmpty,
    expected_outcome: nonEmpty,
    expected_tools: z.array(identifier).optional(),
    assert_response_contains: nonEmpty.optional(),
    assert_contract: z.enum(['clean', 'no-fail']).optional(),
    identity: z.object({
      subject: nonEmpty.optional(),
      session: z.enum(['same', 'new']).optional(),
      none: z.literal(true).optional(),
    }).strict().optional(),
  }).strict()).min(1, 'must contain at least one interaction test'),
  contract_checks: z.array(nonEmpty).default([]),
  golden_prompts: z.array(z.object({
    id: identifier,
    prompt: nonEmpty,
    expected_tool_behavior: nonEmpty,
  }).strict()).default([]),
}).strict()

const deliverySchema = z.object({
  source: z.object({
    kind: z.enum(['repository', 'archive', 'manual']),
    locator: nonEmpty,
    revision: nonEmpty.optional(),
  }).strict(),
  environments: z.array(z.object({
    name: identifier,
    deploy_target: nonEmpty,
    server_url: httpUrl,
    region: nonEmpty.optional(),
    secret_references: z.array(credentialReferenceSchema).default([]),
  }).strict()).min(1, 'must contain at least one environment'),
  rollback: z.object({
    strategy: nonEmpty,
    reference: nonEmpty.optional(),
  }).strict(),
}).strict()

const reviewEvidenceSchema = z.object({
  listing: z.object({
    name: nonEmpty,
    description: nonEmpty,
    icon: nonEmpty,
    subtitle: nonEmpty.optional(),
    privacy_policy_url: httpUrl.optional(),
    terms_url: httpUrl.optional(),
    company_url: httpUrl.optional(),
    support_url: httpUrl.optional(),
  }).strict(),
  screenshots: z.array(nonEmpty).default([]),
  demo_access: z.object({
    instructions: nonEmpty,
    credential_references: z.array(credentialReferenceSchema).default([]),
  }).strict().optional(),
  reviewer_cases: z.array(z.object({
    id: identifier,
    prompt: nonEmpty,
    expected_outcome: nonEmpty,
  }).strict()).default([]),
  real_host_result: z.object({
    status: z.enum(['not-run', 'passed', 'failed', 'not-applicable']),
    reference: nonEmpty.optional(),
    evaluated_at: isoTimestamp.optional(),
    provenance: z.object({
      attestation: z.enum(['automated', 'reviewer-attested', 'user-attested']),
      evidence_date: isoDate,
      source_revision: nonEmpty,
      host_version: nonEmpty,
      retained_artifacts: z.object({
        screenshots: z.boolean(),
        transcript: z.boolean(),
      }).strict(),
    }).strict().optional(),
  }).strict(),
}).strict()

const policyProvenanceSchema = z.object({
  bundle: z.object({
    id: identifier,
    version: nonEmpty,
    sha256: z.string().regex(/^[a-f0-9]{64}$/, 'must be a lowercase SHA-256 digest').optional(),
  }).strict(),
  rules: z.array(z.object({
    id: policyRuleId,
    source: httpUrl,
    verified_at: isoTimestamp,
    confidence: z.enum(['verified', 'inferred', 'unverified']),
    applicability: z.enum(['applies', 'does-not-apply', 'uncertain']),
    implementation_version: nonEmpty,
  }).strict()).min(1, 'must contain at least one policy rule'),
}).strict()

export const pluginBlueprintV1Schema = z.object({
  schema_version: z.literal(BLUEPRINT_SCHEMA_VERSION, {errorMap: () => ({message: `schema_version must be ${BLUEPRINT_SCHEMA_VERSION}`})}),
  id: identifier,
  revision: nonEmpty,
  intent: intentSchema,
  product_contract: productContractSchema,
  data_security: dataSecuritySchema,
  identity: identitySchema,
  quality: qualitySchema,
  delivery: deliverySchema,
  review_evidence: reviewEvidenceSchema,
  policy_provenance: policyProvenanceSchema,
}).strict().superRefine((blueprint, context) => {
  const realHost = blueprint.review_evidence.real_host_result
  if (!realHost.provenance) return

  if (realHost.status !== 'passed' && realHost.status !== 'failed') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['review_evidence', 'real_host_result', 'provenance'],
      message: 'may only be recorded for passed or failed real-host evidence',
    })
  }

  if (realHost.provenance.source_revision !== blueprint.delivery.source.revision) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['review_evidence', 'real_host_result', 'provenance', 'source_revision'],
      message: 'must exactly match delivery.source.revision',
    })
  }
})

export type PluginBlueprintV1 = z.infer<typeof pluginBlueprintV1Schema>

export function validatePluginBlueprint(value: unknown): PluginBlueprintV1 {
  const result = pluginBlueprintV1Schema.safeParse(value)
  if (result.success) return result.data

  throw new BlueprintValidationError(formatValidationIssues(result.error))
}

export function formatValidationIssues(error: ZodError): BlueprintValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
    message: issue.message,
  }))
}
