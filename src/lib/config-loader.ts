import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {configFilePath} from './naming.js'

import yaml from 'js-yaml'
import {ZodError} from 'zod'

import {type AppRhythmConfig, apprhythmConfigSchema} from './config-schema.js'

export class ConfigLoadError extends Error {
  constructor(message: string, public readonly details?: string[]) {
    super(message)
    this.name = 'ConfigLoadError'
  }
}

function remediationHint(fieldPath: string, message: string): string {
  if (message.includes('unrecognized')) {
    if (fieldPath === '(root)') {
      return 'Remove the unrecognized key or check for typos.'
    }

    return `Remove the unrecognized key from the "${fieldPath.split('.')[0]}" section.`
  }

  if (fieldPath === 'server.auth.oauth.token_endpoint_auth_method') return 'Use client_secret_basic or client_secret_post with client_id and a client_secret reference, or omit this setting for SDK discovery/defaults.'
  if (fieldPath.startsWith('server.auth')) return 'Use environment or keychain references (never raw secrets); OAuth owns Authorization. Run `ritmo auth mcp --help`.'

  if (fieldPath === 'version') {
    return 'Set version to 1 (the only supported schema version).'
  }

  if (fieldPath === 'server.url') {
    return 'Provide a valid HTTP or HTTPS URL (e.g., http://localhost:2091/mcp).'
  }

  if (message.includes('Required')) {
    return `Add the missing "${fieldPath}" field. Run \`ritmo init\` to generate a starter config.`
  }

  if (message.includes('must not be empty')) {
    return `Provide a non-empty value for "${fieldPath}".`
  }

  return 'Run `ritmo init` to generate a valid starter config.'
}

function formatZodErrors(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const fieldPath = issue.path.length > 0 ? issue.path.join('.') : '(root)'
    const hint = remediationHint(fieldPath, issue.message)
    return `  ${fieldPath}: ${issue.message} → ${hint}`
  })
}

export async function loadConfig(dir?: string): Promise<AppRhythmConfig> {
  const configDir = dir ?? process.cwd()
  const configPath = configFilePath(configDir)

  let raw: string
  try {
    raw = await readFile(configPath, 'utf8')
  } catch {
    throw new ConfigLoadError(`Config file not found: ${configPath}`)
  }

  let parsed: unknown
  try {
    parsed = yaml.load(raw)
  } catch {
    throw new ConfigLoadError(`Failed to parse YAML in ${configPath}`)
  }

  const result = apprhythmConfigSchema.safeParse(parsed)
  if (!result.success) {
    const details = formatZodErrors(result.error)
    throw new ConfigLoadError(
      `Invalid ${path.basename(configPath)} (${result.error.issues.length} error${result.error.issues.length === 1 ? '' : 's'}):`,
      details,
    )
  }

  return result.data
}
