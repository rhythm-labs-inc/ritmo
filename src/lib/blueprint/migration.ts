import {BlueprintMigrationError} from './errors.js'
import {BLUEPRINT_SCHEMA_VERSION, type PluginBlueprintV1, validatePluginBlueprint} from './schema.js'

/**
 * Migrate an untrusted Blueprint document to the current schema version.
 *
 * v1 is the first format, so its only registered path is identity validation.
 * Later versions must add an explicit, tested migration here; callers never
 * guess how to reinterpret an unsupported document.
 */
export function migratePluginBlueprint(value: unknown): PluginBlueprintV1 {
  const schemaVersion = readSchemaVersion(value)
  if (schemaVersion !== BLUEPRINT_SCHEMA_VERSION) {
    throw new BlueprintMigrationError(schemaVersion, BLUEPRINT_SCHEMA_VERSION)
  }

  return validatePluginBlueprint(value)
}

function readSchemaVersion(value: unknown): number | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined

  const schemaVersion = (value as Record<string, unknown>).schema_version
  return typeof schemaVersion === 'number' ? schemaVersion : undefined
}
