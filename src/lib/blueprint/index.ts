/**
 * Public-to-the-repository Blueprint boundary.
 *
 * Keep adapter imports out of this entry point. See docs/architecture.md.
 */
export {
  BlueprintLoadError,
  BlueprintMigrationError,
  BlueprintProjectionError,
  BlueprintValidationError,
  type BlueprintValidationIssue,
} from './errors.js'
export {loadPluginBlueprint} from './loader.js'
export {migratePluginBlueprint} from './migration.js'
export {projectPluginBlueprint, type BlueprintProjection, type BlueprintProjectionOptions} from './projection.js'
export {
  BLUEPRINT_SCHEMA_VERSION,
  formatValidationIssues,
  pluginBlueprintV1Schema,
  validatePluginBlueprint,
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
  type PluginBlueprintV1,
} from './schema.js'
