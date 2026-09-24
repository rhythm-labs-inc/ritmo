import {readFile} from 'node:fs/promises'

import yaml from 'js-yaml'

import {BlueprintLoadError, BlueprintMigrationError, BlueprintValidationError} from './errors.js'
import {migratePluginBlueprint} from './migration.js'
import type {PluginBlueprintV1} from './schema.js'

/** Read a JSON or YAML Blueprint revision and migrate it to the current schema. */
export async function loadPluginBlueprint(filePath: string): Promise<PluginBlueprintV1> {
  let source: string
  try {
    source = await readFile(filePath, 'utf8')
  } catch {
    throw new BlueprintLoadError(`Blueprint file not found: ${filePath}`, 'Pass --blueprint <PATH> with a readable JSON or YAML Blueprint file.')
  }

  let parsed: unknown
  try {
    parsed = yaml.load(source)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new BlueprintLoadError(`Failed to parse Blueprint ${filePath}: ${message}`, 'Use valid JSON or YAML and keep the document root as an object.')
  }

  try {
    return migratePluginBlueprint(parsed)
  } catch (error) {
    if (error instanceof BlueprintValidationError) {
      const details = error.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')
      throw new BlueprintLoadError(`Invalid Blueprint ${filePath}: ${details}`, 'Fix the listed fields or migrate the document to a supported schema_version.')
    }
    if (error instanceof BlueprintMigrationError) {
      throw new BlueprintLoadError(`Unsupported Blueprint ${filePath}: ${error.message}`, 'Use schema_version 1 or add a registered migration before using this revision.')
    }
    throw error
  }
}
