import {describe, expect, it} from 'vitest'

import {runRules} from '../../src/lib/validate/run.js'
import {VALIDATION_REPORT_VERSION, type ValidationContext} from '../../src/lib/validate/types.js'

const context: ValidationContext = {
  serverUrl: 'https://example.test/mcp',
  host: 'chatgpt',
  server: {name: 'Example', capabilities: {}},
  probes: {},
  tools: [],
  resources: [],
  templates: new Map(),
}

describe('validation JSON report contract', () => {
  it('has a versioned, stable top-level shape', () => {
    const report = runRules(context, {rules: []})

    expect(report.version).toBe(VALIDATION_REPORT_VERSION)
    expect(Object.keys(report).sort()).toEqual([
      'findings',
      'health',
      'host',
      'serverName',
      'serverUrl',
      'summary',
      'templateCount',
      'toolCount',
      'version',
    ])
    expect(Object.keys(report.summary).sort()).toEqual(['fail', 'info', 'pass', 'warn'])
  })
})
