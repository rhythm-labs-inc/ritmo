import type {AppRhythmConfig} from '../config-schema.js'
import {testSuiteSchema, type TestSuite} from '../test-runner/schema.js'

import {BlueprintProjectionError} from './errors.js'
import type {PluginBlueprintV1} from './schema.js'

export interface BlueprintProjectionOptions {
  /** Delivery environment to use. Defaults to the only environment or the first declared environment. */
  environment?: string
  /** Test-suite path written into the projected config. The suite itself is returned in memory. */
  testSuiteFile?: string
}

export interface BlueprintProjection {
  blueprint: {
    id: string
    revision: string
    schemaVersion: number
  }
  environment: string
  config: AppRhythmConfig
  testSuite: TestSuite
}

/**
 * Deterministically project a Blueprint revision to the existing AppRhythm
 * config and test-suite contracts. This is intentionally one-way.
 */
export function projectPluginBlueprint(
  blueprint: PluginBlueprintV1,
  options: BlueprintProjectionOptions = {},
): BlueprintProjection {
  const environment = selectEnvironment(blueprint, options.environment)
  const testSuiteFile = options.testSuiteFile ?? `./tests/${blueprint.id}.yaml`
  const testSuite = projectTestSuite(blueprint)
  const listing = blueprint.review_evidence.listing

  const config: AppRhythmConfig = {
    version: 1,
    app: {
      name: listing.name,
      ...(listing.subtitle ? {subtitle: listing.subtitle} : {}),
      description: listing.description,
      icon: listing.icon,
      screenshots: blueprint.review_evidence.screenshots,
      ...(listing.privacy_policy_url ? {privacy_policy_url: listing.privacy_policy_url} : {}),
      ...(listing.terms_url ? {terms_url: listing.terms_url} : {}),
      ...(listing.company_url ? {company_url: listing.company_url} : {}),
      ...(listing.support_url ? {support_url: listing.support_url} : {}),
    },
    server: {url: environment.server_url},
    simulate: {
      model: blueprint.quality.evaluation.model,
      default_context: {
        locale: blueprint.quality.evaluation.locale,
        timezone: blueprint.quality.evaluation.timezone,
      },
    },
    tests: [{file: testSuiteFile}],
  }

  return {
    blueprint: {id: blueprint.id, revision: blueprint.revision, schemaVersion: blueprint.schema_version},
    environment: environment.name,
    config,
    testSuite,
  }
}

function selectEnvironment(blueprint: PluginBlueprintV1, requested: string | undefined) {
  const environments = blueprint.delivery.environments
  const selected = requested
    ? environments.find((environment) => environment.name === requested)
    : environments[0]

  if (!selected) {
    throw new BlueprintProjectionError(
      `Blueprint ${blueprint.id}@${blueprint.revision} has no environment named "${requested}".`,
      `Choose one of: ${environments.map((environment) => environment.name).join(', ')}.`,
    )
  }
  return selected
}

function projectTestSuite(blueprint: PluginBlueprintV1): TestSuite {
  const projected = {
    suite: `${blueprint.id}@${blueprint.revision}`,
    tests: blueprint.quality.interaction_tests.map((test) => ({
      name: test.id,
      class: test.class === 'negative' ? 'negative' : test.class === 'indirect' ? 'indirect' : 'direct',
      user: test.prompt,
      ...(test.expected_tools ? {tools_called: test.expected_tools} : test.class === 'negative' ? {expect_no_tool_call: true} : {}),
      ...(test.assert_response_contains ? {assert_response_contains: test.assert_response_contains} : {}),
      ...(test.assert_contract ? {assert_contract: test.assert_contract} : {}),
      ...(test.identity ? {identity: test.identity} : {}),
    })),
  }

  const result = testSuiteSchema.safeParse(projected)
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
    throw new BlueprintProjectionError(
      `Blueprint ${blueprint.id}@${blueprint.revision} cannot project to the YAML test-suite contract: ${details}`,
      'Use test ids, prompts, expected_tools, identity, response, and contract assertions that the current test-suite schema supports.',
    )
  }
  return result.data
}
