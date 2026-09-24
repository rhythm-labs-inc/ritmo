import {configFilePath} from '../naming.js'
import {readFile, open, rename, unlink} from 'node:fs/promises'
import {constants} from 'node:fs'
import {randomUUID} from 'node:crypto'
import path from 'node:path'
import yaml from 'js-yaml'
import {apprhythmConfigSchema} from '../config-schema.js'
import {mcpAuthSchema, type McpAuthConfig} from './auth-schema.js'
import {authenticationError} from './connection.js'

/** Persist only validated references. A URL change requires a new explicit configuration. */
export async function saveMcpAuth(root: string, serverUrl: string, auth: McpAuthConfig): Promise<void> {
  const checked = mcpAuthSchema.safeParse(auth)
  if (!checked.success) throw authenticationError('Invalid authentication configuration. Use secret references and remove conflicting headers.')
  const file = configFilePath(root)
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  let original: string
  try { original = await handle.readFile('utf8') } finally { await handle.close() }
  const document = yaml.load(original) as {server: {url: string; auth?: McpAuthConfig}}
  apprhythmConfigSchema.parse(document)
  if (new URL(document.server.url).href !== new URL(serverUrl).href) throw authenticationError('The configured endpoint changed. Reload before editing authentication.')
  if (Object.keys(checked.data).length) document.server.auth = checked.data
  else delete document.server.auth
  const temporary = path.join(root, `.ritmo-auth-${randomUUID()}.tmp`)
  const output = await open(temporary, 'wx', 0o600)
  try { await output.writeFile(yaml.dump(document, {lineWidth: -1, noRefs: true})) } finally { await output.close() }
  try {
    if (configFilePath(root) !== file || await readFile(file, 'utf8') !== original) throw authenticationError('Configuration changed. Retry against the current file.')
    await rename(temporary, file)
  } finally { await unlink(temporary).catch(() => {}) }
}
