import {readFile} from 'node:fs/promises'

import yaml from 'js-yaml'

import {type TestSuite, testSuiteSchema} from './schema.js'

export class TestLoadError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
  ) {
    super(message)
    this.name = 'TestLoadError'
  }
}

/**
 * Load and validate a YAML test suite from a file path.
 * Throws `TestLoadError` for file-not-found, parse errors, or schema violations.
 */
export async function loadTestSuite(filePath: string): Promise<TestSuite> {
  // 1. Read file
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch {
    throw new TestLoadError(
      `Test file not found: ${filePath}`,
      'Check the file path and ensure the file exists.',
    )
  }

  // 2. Parse YAML
  let parsed: unknown
  try {
    parsed = yaml.load(raw)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new TestLoadError(
      `Failed to parse YAML in ${filePath}: ${msg}`,
      'Ensure the file contains valid YAML.',
    )
  }

  if (parsed === null || typeof parsed !== 'object') {
    throw new TestLoadError(
      `Test file ${filePath} is empty or not a YAML object.`,
      'The file must contain a YAML mapping with a "tests" key.',
    )
  }

  // 3. Validate schema
  const result = testSuiteSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.') || 'root'}: ${i.message}`)
      .join('\n')
    throw new TestLoadError(
      `Invalid test suite in ${filePath}:\n${issues}`,
      'Fix the schema errors above and re-run.',
    )
  }

  return result.data
}
