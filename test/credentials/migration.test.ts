import {afterEach, beforeEach, expect, it, vi} from 'vitest'
import {deleteCredential, getCredential, setBackend, setCredential} from '../../src/lib/credentials/store.js'
import {keychainDisabled, resolveCredential} from '../../src/lib/credentials/resolution.js'
import {McpOAuthProvider} from '../../src/lib/mcp/oauth.js'

let values: Map<string, string>
beforeEach(() => {
  values = new Map()
  for (const prefix of ['RITMO', 'APPRHYTHM']) {
    vi.stubEnv(`${prefix}_NO_KEYCHAIN`, '')
    vi.stubEnv(`${prefix}_OPENAI_API_KEY`, '')
  }
  setBackend({
    async getPassword(service, account) {return values.get(`${service}/${account}`) ?? null},
    async setPassword(service, account, value) {values.set(`${service}/${account}`, value)},
    async deletePassword(service, account) {return values.delete(`${service}/${account}`)},
  })
})
afterEach(() => {setBackend(null); vi.unstubAllEnvs()})

it('reads legacy keys, writes canonical keys, resolves conflicts and clears both', async () => {
  values.set('apprhythm/openai', 'legacy-key')
  expect(await getCredential('openai')).toBe('legacy-key')
  await setCredential('openai', 'canonical-key')
  expect(values.get('apprhythm/openai')).toBe('legacy-key')
  expect(await getCredential('openai')).toBe('canonical-key')
  expect(await deleteCredential('openai')).toBe(true)
  expect(await getCredential('openai')).toBeNull()
})
it('preserves endpoint and account isolation when reading, refreshing and clearing old OAuth sessions', async () => {
  const url = 'https://example.com/mcp'
  const provider = await McpOAuthProvider.create(url, {account: 'alice'})
  const token = {access_token: 'legacy-token', token_type: 'Bearer'}
  values.set(`apprhythm/${provider.storageKey}`, JSON.stringify({tokens: token}))
  const restored = await McpOAuthProvider.create(url, {account: 'alice'})
  expect(await restored.tokens()).toMatchObject(token)
  expect(await (await McpOAuthProvider.create(url, {account: 'bob'})).tokens()).toBeUndefined()
  expect(await (await McpOAuthProvider.create('https://other.example/mcp', {account: 'alice'})).tokens()).toBeUndefined()
  await restored.saveTokens({access_token: 'new-token', token_type: 'Bearer'})
  expect(JSON.parse(values.get(`ritmo/${provider.storageKey}`)!).tokens.access_token).toBe('new-token')
  expect(JSON.parse(values.get(`apprhythm/${provider.storageKey}`)!).tokens.access_token).toBe('legacy-token')
  expect(await (await McpOAuthProvider.create(url, {account: 'alice'})).tokens()).toMatchObject({access_token: 'new-token'})
  await McpOAuthProvider.clearSession(url, {account: 'alice'})
  expect(await (await McpOAuthProvider.create(url, {account: 'alice'})).tokens()).toBeUndefined()
})
it('does not bypass a failed canonical read and reports failed deletion without exposing secrets', async () => {
  const get = vi.fn(async () => {throw new Error('private-value')})
  setBackend({getPassword: get, async setPassword() {}, async deletePassword() {throw new Error('private-value')}})
  await expect(getCredential('openai')).rejects.toMatchObject({category: 'keychain-failure', message: 'Failed to read credential for provider "openai"'})
  expect(get).toHaveBeenCalledTimes(1)
  await expect(deleteCredential('openai')).rejects.toMatchObject({category: 'keychain-failure'})
})
it('uses canonical environment credentials without requiring an available keychain', async () => {
  setBackend({async getPassword() {throw new Error('unavailable')}, async setPassword() {throw new Error('unavailable')}, async deletePassword() {throw new Error('unavailable')}})
  vi.stubEnv('APPRHYTHM_OPENAI_API_KEY', 'legacy')
  vi.stubEnv('RITMO_OPENAI_API_KEY', ' canonical ')
  expect(await resolveCredential('openai')).toEqual({source: 'env', value: 'canonical'})
  vi.stubEnv('RITMO_OPENAI_API_KEY', '')
  vi.stubEnv('RITMO_NO_KEYCHAIN', '1')
  expect(await resolveCredential('openai')).toBeNull()
  expect(keychainDisabled({RITMO_NO_KEYCHAIN: 'false', APPRHYTHM_NO_KEYCHAIN: '1'})).toBe(false)
  expect(keychainDisabled({APPRHYTHM_NO_KEYCHAIN: '1'})).toBe(true)
})
