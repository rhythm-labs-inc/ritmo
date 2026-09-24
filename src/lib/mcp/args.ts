import {readFile} from 'node:fs/promises'

import {McpError} from './errors.js'

export async function parseToolArgs(
  argsJson: string | undefined,
  argsFile: string | undefined,
): Promise<Record<string, unknown>> {
  if (argsJson !== undefined && argsFile !== undefined) {
    throw new McpError(
      'args',
      '--args and --args-file are mutually exclusive',
      'Provide only one of --args or --args-file, not both.',
    )
  }

  if (argsJson === undefined && argsFile === undefined) {
    return {}
  }

  let raw: string
  if (argsFile !== undefined) {
    try {
      raw = await readFile(argsFile, 'utf8')
    } catch {
      throw new McpError(
        'args',
        `Could not read args file: ${argsFile}`,
        'Check the file path is correct and the file exists.',
      )
    }
  } else {
    raw = argsJson!
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    const source = argsFile ? `file ${argsFile}` : '--args value'
    throw new McpError(
      'args',
      `Invalid JSON in ${source}`,
      'Provide valid JSON. Example: --args \'{"param":"value"}\'',
    )
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    const source = argsFile ? `file ${argsFile}` : '--args value'
    throw new McpError(
      'args',
      `Args from ${source} must be a JSON object, not ${Array.isArray(parsed) ? 'array' : typeof parsed}`,
      'Provide a JSON object as args. Example: --args \'{"param":"value"}\'',
    )
  }

  return parsed as Record<string, unknown>
}
