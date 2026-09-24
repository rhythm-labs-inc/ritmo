import {useState} from 'react'

export function SmokeDraft({disabled}: {disabled: boolean}) {
  const [draft, setDraft] = useState<{id: string; yaml: string} | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [filename, setFilename] = useState('smoke.yaml')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  async function request(save = false) {
    setBusy(true); setMessage('')
    try {
      const response = await fetch('/api/smoke-draft', save ? {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({id: draft?.id, confirmed, filename})} : {})
      const body = await response.json()
      if (!response.ok) throw new Error(body.error)
      if (save) { setDraft(null); setMessage(`Saved ${body.file}. Run: ritmo test --file ./${body.file}`) }
      else { setDraft(body); setConfirmed(false) }
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not prepare draft.') }
    finally { setBusy(false) }
  }
  return <div className="smoke-draft">
    <button className="reset-btn" disabled={disabled || busy} onClick={() => request()}>Draft smoke test</button>
    {message && <p role="status">{message}</p>}
    {draft && <section aria-label="Review smoke test draft">
      <p>Observed behavior is a proposed expectation, not proof of correctness. Review the prompt for private data and confirm the expected tools. This draft supports one typed turn with any number of tools; nonempty lists require at least those tools, and an empty list forbids all calls.</p>
      <pre>{draft.yaml}</pre>
      <label>Save in tests/ <input aria-label="Draft filename" value={filename} onChange={(event) => setFilename(event.target.value)} /></label>
      <label className="draft-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> I reviewed the prompt and proposed assertions and want to save this draft.</label>
      <button className="reset-btn" disabled={!confirmed || disabled || busy} onClick={() => request(true)}>Save reviewed draft</button>
      <button className="reset-btn" onClick={() => setDraft(null)}>Cancel</button>
    </section>}
  </div>
}
