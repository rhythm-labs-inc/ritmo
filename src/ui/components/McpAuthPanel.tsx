import {useEffect, useState} from 'react'
import type {McpAuthConfig} from '../../lib/mcp/auth-schema'

type State = {session: string; configuration: McpAuthConfig; status: {status: string; error?: string}; loggingIn: boolean; error?: string}
type WorkspaceApi = <T>(route: string, body?: unknown, headers?: Record<string, string>) => Promise<T>

export function McpAuthPanel({api}: {api?: WorkspaceApi}) {
  const [state, setState] = useState<State>()
  const [mode, setMode] = useState('none')
  const [header, setHeader] = useState('X-API-Key')
  const [variable, setVariable] = useState('')
  const [bearer, setBearer] = useState(false)
  const [clientId, setClientId] = useState('')
  const [account, setAccount] = useState('default')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const request = async <T,>(route = '', body?: unknown): Promise<T> => {
    const headers = {'x-ritmo-auth-session': state?.session ?? ''}
    if (api) return api<T>('project/auth' + route, body, headers)
    const response = await fetch('/api/mcp-auth' + route, body === undefined ? {} : {method: 'POST', headers: {...headers, 'content-type': 'application/json'}, body: JSON.stringify(body)})
    const result = await response.json()
    if (!response.ok) throw new Error(result.error ?? 'Could not update authentication.')
    return result as T
  }
  const reload = async (initialize = false) => {
    const next = await request<State>()
    setState(next)
    if (initialize) {
      setMode(next.configuration.oauth ? 'oauth' : next.configuration.headers ? 'headers' : 'none')
      setClientId(next.configuration.oauth?.client_id ?? '')
      setAccount(next.configuration.oauth?.account ?? 'default')
      const entry = Object.entries(next.configuration.headers ?? {})[0]
      if (entry) { setHeader(entry[0]); setVariable('env' in entry[1] ? entry[1].env : ''); setBearer(entry[1].prefix === 'Bearer ') }
    }
  }
  useEffect(() => { void reload(true).catch(() => {}); }, [])
  useEffect(() => {
    if (!state?.loggingIn) return
    const timer = setInterval(() => { void reload().catch(() => {}) }, 1000)
    return () => clearInterval(timer)
  }, [state?.loggingIn])
  const action = async (route: string, body: unknown = {}) => {
    setBusy(true); setError(''); setNotice('')
    try { await request(route, body); await reload(); if (route === '/configure') setNotice('Authentication saved.') }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not update authentication.') }
    finally { setBusy(false) }
  }
  const save = () => {
    let auth: McpAuthConfig = {}
    if (mode === 'oauth') auth = {oauth: {...state?.configuration.oauth, client_id: clientId || undefined, account}, ...(state?.configuration.oauth && state.configuration.headers ? {headers: state.configuration.headers} : {})}
    if (mode === 'headers') auth = {headers: {[header]: {env: variable, ...(bearer ? {prefix: 'Bearer '} : {})}}}
    return action('/configure', auth)
  }
  return <details className="mcp-auth-panel">
    <summary>MCP authentication · {state?.loggingIn ? 'waiting for authorization' : state?.status.status ?? 'loading'}</summary>
    <p>Connect to your MCP server using OAuth or a secret stored in the environment of this Ritmo process. Secrets stay out of your project files and conversation.</p>
    <label>Authentication <select value={mode} onChange={(e) => setMode(e.target.value)}><option value="none">None</option><option value="headers">Custom header</option><option value="oauth">OAuth</option></select></label>
    {mode === 'headers' && <>
      <label>Header name <input value={header} onChange={(e) => setHeader(e.target.value)} /></label>
      <label>Environment variable name <input value={variable} placeholder="MY_MCP_TOKEN" onChange={(e) => setVariable(e.target.value)} /></label>
      <p>Enter the variable name here, such as <code>MY_MCP_TOKEN</code>. Set its secret value through a secret manager or hidden local prompt before starting Ritmo. Do not paste the token in this field.</p>
      <label><input type="checkbox" checked={bearer} onChange={(e) => setBearer(e.target.checked)} /> Add Bearer prefix</label>
      {bearer && <p>Set the header name to <code>Authorization</code>. Store only the token in the environment variable; Ritmo adds <code>Bearer </code>. Synthetic example (not a working credential): from <code>Authorization: Bearer demo-token-123</code>, use only <code>demo-token-123</code>. Omit <code>Authorization:</code>, <code>Bearer</code>, quotes, and the surrounding command.</p>}
      <p>Saving replaces the configured headers with this one header. Use ritmo.yaml for multiple headers or keychain references.</p>
    </>}
    {mode === 'oauth' && <><label>Client ID (if pre-registered) <input value={clientId} onChange={(e) => setClientId(e.target.value)} /></label><label>Account label <input value={account} onChange={(e) => setAccount(e.target.value)} /></label><p>Without a client ID, the server must support dynamic registration. The default callback is http://127.0.0.1:49178/callback.</p></>}
    <div className="mcp-auth-actions"><button disabled={busy || state?.loggingIn} onClick={() => void save()}>Save authentication</button>{state?.configuration.oauth && <><button disabled={busy || state.loggingIn} onClick={() => void action('/login')}>Connect / reconnect</button><button disabled={busy} onClick={() => void action('/clear')}>Forget saved login</button></>}{state?.loggingIn && <button disabled={busy} onClick={() => void action('/cancel')}>Cancel login</button>}</div>
    {notice && <p role="status" className="mcp-auth-notice">{notice}</p>}
    {(error || state?.error || state?.status.error) && <p role="alert">{error || state?.error || state?.status.error}</p>}
  </details>
}
