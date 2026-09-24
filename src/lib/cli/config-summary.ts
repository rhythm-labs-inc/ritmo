import type {AppRhythmConfig} from '../config-schema.js'
import {redactSensitiveFields} from '../mcp/redaction.js'
import {displayText} from './builder-experience.js'

/** Summarizes saved settings only; no network or filesystem verification. */
export function formatConfigSummary(config: AppRhythmConfig, file: string): string {
  const safe = redactSensitiveFields(config) as AppRhythmConfig
  return [
    'Your configuration',
    '',
    `App: ${displayText(safe.app.name)}`,
    `MCP server: ${displayText(safe.server.url)}`,
    `Model for simulation: ${displayText(safe.simulate.model)}`,
    ...safe.tests.map(test => `Test file: ${displayText(test.file)}`),
    '',
    `Saved in: ${displayText(file)}`,
    '',
    'View all settings: ritmo config show --verbose',
  ].join('\n')
}
