import {afterEach, describe, expect, it} from 'vitest'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'
import {buildSmokeDraft, saveSmokeDraft} from '../../src/lib/test-runner/smoke-draft.js'
import {addUserMessage, getSessionState, resetSession, setSuccess} from '../../src/lib/server/session-store.js'
import {testSuiteSchema} from '../../src/lib/test-runner/schema.js'

afterEach(resetSession)
function successful() {
  resetSession(); addUserMessage('List my apps')
  setSuccess('Private result text', [{toolName: 'list_apps', status: 'success', latencyMs: 1, response: {content: [], _meta: {token: 'PRIVATE_TOKEN'}}, request: {password: 'PRIVATE_PASSWORD'}}])
  return getSessionState()
}
describe('reviewed smoke drafts', () => {
  it('exports just a prompt and deduplicated observed tool expectations', () => {
    const state = successful(); state.trace.push(state.trace[0])
    const draft = buildSmokeDraft(state)
    expect(testSuiteSchema.parse(yaml.load(draft.yaml)).tests[0]).toMatchObject({user: 'List my apps', tools_called: ['list_apps']})
    expect(draft.yaml).not.toMatch(/PRIVATE|Private|password|_meta/)
    expect(draft.yaml).toContain('not proof of correctness')
  })
  it('requires confirmation, rejects stale reviews and never overwrites', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smoke-draft-'))
    try {
      const state = successful(), draft = buildSmokeDraft(state)
      await expect(saveSmokeDraft(state, {id: draft.id, confirmed: false, filename: 'smoke.yaml'}, dir)).rejects.toThrow(/confirm/i)
      await saveSmokeDraft(state, {id: draft.id, confirmed: true, filename: 'smoke.yaml'}, dir)
      expect(await readFile(path.join(dir, 'tests/smoke.yaml'), 'utf8')).toBe(draft.yaml)
      await expect(saveSmokeDraft(state, {id: draft.id, confirmed: true, filename: 'smoke.yaml'}, dir)).rejects.toThrow(/exists/)
      await expect(saveSmokeDraft(state, {id: 'stale', confirmed: true, filename: 'other.yaml'}, dir)).rejects.toThrow(/changed/)
      await expect(saveSmokeDraft(state, {id: draft.id, confirmed: true, filename: '../escape.yaml'}, dir)).rejects.toThrow(/filename/)
    } finally { await rm(dir, {recursive: true, force: true}) }
  })
  it('rejects failed, multi-turn, widget-driven, and credential-bearing prompts', () => {
    const state = successful(); state.trace[0].status = 'error'
    expect(() => buildSmokeDraft(state)).toThrow(/successful/)
    successful(); addUserMessage('second'); setSuccess('ok', [])
    expect(() => buildSmokeDraft(getSessionState())).toThrow(/single/)
    const widget = successful(); widget.messages[0].origin = 'widget'
    expect(() => buildSmokeDraft(widget)).toThrow(/typed/)
    const secret = successful(); secret.messages[0].content = 'password=PRIVATE_PASSWORD'
    expect(() => buildSmokeDraft(secret)).toThrow(/secret/)
  })
})
