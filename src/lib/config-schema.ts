import {z} from 'zod'
import {mcpAuthSchema} from './mcp/auth-schema.js'

const httpUrl = z.string().min(1, 'URL must not be empty').url('Must be a valid URL').refine(
  (url) => url.startsWith('http://') || url.startsWith('https://'),
  {message: 'URL must use http:// or https:// scheme'},
)

const httpsUrl = z.string().min(1, 'URL must not be empty').url('Must be a valid URL').refine(
  (url) => url.startsWith('https://'),
  {message: 'URL must use https://'},
)

const appSchema = z.object({
  name: z.string().min(1, 'app.name must not be empty'),
  /** Listing subtitle (portal-enforced ≤ 30 chars, checked by `validate`). */
  subtitle: z.string().min(1, 'app.subtitle must not be empty').optional(),
  description: z.string().min(1, 'app.description must not be empty'),
  icon: z.string().min(1, 'app.icon must not be empty'),
  // Listing needs ≥ 3, but that is a submission concern checked by `validate`
  // (rule config/screenshots), not a precondition for local simulation.
  screenshots: z.array(z.string().min(1, 'Each screenshot path must not be empty')).default([]),
  privacy_policy_url: httpsUrl.optional(),
  company_url: httpsUrl.optional(),
  support_url: httpsUrl.optional(),
  terms_url: httpsUrl.optional(),
}).strict()

const serverSchema = z.object({
  url: httpUrl,
  auth: mcpAuthSchema.optional(),
}).strict()

const defaultContextSchema = z.object({
  locale: z.string().min(1, 'simulate.default_context.locale must not be empty'),
  timezone: z.string().min(1, 'simulate.default_context.timezone must not be empty'),
}).strict()

const simulateSchema = z.object({
  model: z.string().min(1, 'simulate.model must not be empty'),
  default_context: defaultContextSchema,
}).strict()

const testEntrySchema = z.object({
  file: z.string().min(1, 'Each test entry file path must not be empty'),
}).strict()

// ---------------------------------------------------------------------------
// submission: — everything the OpenAI submission portal asks for that isn't
// derivable from the MCP server itself. See docs/apps-sdk-contract.md §8.
// ---------------------------------------------------------------------------

const annotationJustificationsSchema = z.object({
  readOnlyHint: z.string().min(1).optional(),
  destructiveHint: z.string().min(1).optional(),
  openWorldHint: z.string().min(1).optional(),
}).strict()

const submissionToolSchema = z.object({
  /** Free-text justification per annotation, as the portal form asks. */
  justifications: annotationJustificationsSchema.optional(),
}).strict()

const positiveTestCaseSchema = z.object({
  scenario: z.string().min(1, 'scenario must not be empty'),
  prompt: z.string().min(1, 'prompt must not be empty'),
  /** Tool names expected to be triggered. */
  tools: z.array(z.string().min(1)).min(1, 'list at least one expected tool'),
  expected: z.string().min(1, 'expected must not be empty'),
  /** Optional test account / fixture data note for reviewers. */
  fixture: z.string().optional(),
}).strict()

const negativeTestCaseSchema = z.object({
  scenario: z.string().min(1, 'scenario must not be empty'),
  prompt: z.string().min(1, 'prompt must not be empty'),
  /** Expected refusal / clarification / fallback and why the app must not act. */
  rationale: z.string().min(1, 'rationale must not be empty'),
}).strict()

/** A local source tree recorded for a submitted skill. Ritmo does not execute skill code. */
const submissionSkillSchema = z.object({
  name: z.string().min(1, 'skill name must not be empty'),
  path: z.string().min(1, 'skill path must not be empty'),
  delivery: z.enum(['bundle', 'mcp-import']),
}).strict()

const policyAttestationsSchema = z.object({
  /** Human confirmation after reviewing the complete draft. This is not a machine-verifiable policy result. */
  confirmed: z.boolean().default(false),
  confirmed_by: z.string().min(1).optional(),
  confirmed_at: z.string().datetime({offset: true}).optional(),
}).strict()

const releaseNotesSchema = z.object({
  kind: z.enum(['initial', 'update']),
  summary: z.string().min(1, 'release_notes.summary must not be empty'),
  changes: z.string().min(1, 'release_notes.changes must not be empty'),
  reviewer_notes: z.string().min(1, 'release_notes.reviewer_notes must not be empty'),
}).strict()

const submissionSchema = z.object({
  /** Verification token served at https://<challenge_host>/.well-known/openai-apps-challenge */
  challenge_token: z.string().min(1).optional(),
  /** Host for the challenge URL; defaults to the server.url host. */
  challenge_host: z.string().min(1).optional(),
  showcase_prompts: z.array(z.string().min(1)).default([]),
  test_cases: z.array(positiveTestCaseSchema).default([]),
  negative_test_cases: z.array(negativeTestCaseSchema).default([]),
  /** Keyed by tool name. */
  tools: z.record(submissionToolSchema).default({}),
  /** Local skill trees sent as bundles or imported from MCP during portal scan. */
  skills: z.array(submissionSkillSchema).default([]),
  /** ISO 3166-1 alpha-2 country codes selected in the portal's Global tab. */
  country_availability: z.array(z.string().regex(/^[A-Z]{2}$/, 'use uppercase ISO 3166-1 alpha-2 country codes')).default([]),
  /** Human-only portal confirmation; validation records its presence, not policy compliance. */
  policy_attestations: policyAttestationsSchema.optional(),
  /** Material for the portal's release-notes field. */
  release_notes: releaseNotesSchema.optional(),
}).strict()

export const apprhythmConfigSchema = z.object({
  version: z.literal(1, {errorMap: () => ({message: 'version must be 1'})}),
  app: appSchema,
  server: serverSchema,
  simulate: simulateSchema,
  tests: z.array(testEntrySchema).min(1, 'tests must contain at least 1 entry'),
  submission: submissionSchema.optional(),
}).strict()

export type AppRhythmConfig = z.infer<typeof apprhythmConfigSchema>
export type SubmissionConfig = NonNullable<AppRhythmConfig['submission']>
