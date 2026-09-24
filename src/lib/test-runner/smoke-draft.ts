import {createHash} from 'node:crypto'
import {lstat, mkdir, writeFile} from 'node:fs/promises'
import path from 'node:path'
import yaml from 'js-yaml'
import {z} from 'zod'
import type {SessionState} from '../server/session-store.js'
import {testSuiteSchema} from './schema.js'

export class SmokeDraftError extends Error {
  readonly category = 'smoke-draft'
}
export const smokeSaveSchema = z.object({id: z.string(), confirmed: z.literal(true), filename: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.ya?ml$/)}).strict()
export interface SmokeDraft {id: string; yaml: string}

export function buildSmokeDraft(state: SessionState): SmokeDraft {
  if (state.status !== 'success' || state.harness || state.trace.some((event) => event.status !== 'success' || event.response?.isError)) throw new SmokeDraftError('A successful simulator run without tool errors is required.')
  if (state.messages.length !== 2 || state.messages[0].role !== 'user' || state.messages[1].role !== 'assistant') throw new SmokeDraftError('Drafts currently support a single turn. Start a new session and run one prompt.')
  const prompt = state.messages[0]
  if (prompt.origin === 'widget') throw new SmokeDraftError('Drafts require a typed prompt; widget-driven conversations are not replayable by this draft.')
  // Persist an explicit allowlist only; result _meta remains widget-only (docs/apps-sdk-contract.md §4).
  const user = prompt.content
  if (/(?:\bsk-[\w-]{16,}|\bgh[pousr]_[\w]{16,}|\bAKIA[0-9A-Z]{16}|(?:api[_-]?key|token|password|secret|authorization)\s*[:=]\s*\S+|Bearer\s+\S+|https?:\/\/[^\s/]+@)/i.test(user)) throw new SmokeDraftError('The prompt appears to contain a secret. Start a new session with a credential-free prompt before drafting.')
  const suite = testSuiteSchema.parse({suite: 'Simulator smoke draft', tests: [{name: 'Review: observed simulator behavior', user, tools_called: [...new Set(state.trace.map((event) => event.toolName))]}]})
  const output = '# Observed behavior is a proposed expectation, not proof of correctness.\n# Review the prompt and tools before saving or running. Nonempty tools_called means at least these tools; [] means no calls.\n' + yaml.dump(suite, {lineWidth: -1, noRefs: true})
  // Bind confirmation to this exact run as well as its proposed YAML.
  const id = createHash('sha256').update(JSON.stringify([output, state.messages.map((message) => message.timestamp)])).digest('hex')
  return {id, yaml: output}
}

export async function saveSmokeDraft(state: SessionState, request: unknown, cwd = process.cwd()): Promise<string> {
  const parsed = smokeSaveSchema.safeParse(request)
  if (!parsed.success) throw new SmokeDraftError('Explicit confirmation and a simple .yaml filename are required.')
  const draft = buildSmokeDraft(state)
  if (parsed.data.id !== draft.id) throw new SmokeDraftError('The conversation changed. Review a fresh draft before saving.')
  const directory = path.join(cwd, 'tests')
  try {
    await mkdir(directory, {recursive: true})
    if ((await lstat(directory)).isSymbolicLink()) throw new SmokeDraftError('The tests directory must not be a symbolic link.')
    await writeFile(path.join(directory, parsed.data.filename), draft.yaml, {flag: 'wx', mode: 0o600})
  } catch (error) {
    if (error instanceof SmokeDraftError) throw error
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new SmokeDraftError('That file already exists. Choose a new filename; existing tests are never overwritten.')
    throw new SmokeDraftError('Could not save the draft. Check the tests directory permissions.')
  }
  return `tests/${parsed.data.filename}`
}
