#!/usr/bin/env node

import './check-node.js'

// A redirected CLI is a plain-text interface, even if a parent forces colour.
if (!process.stdout.isTTY || process.env.NO_COLOR !== undefined || process.env.CI || process.env.TERM === 'dumb') {
  delete process.env.FORCE_COLOR
  process.env.NO_COLOR = '1'
}
const {execute} = await import('@oclif/core')

await execute({dir: import.meta.url})
