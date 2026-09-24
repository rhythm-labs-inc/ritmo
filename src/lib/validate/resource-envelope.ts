import type {Finding, HostProfile} from './types.js'

const source = 'docs/apps-sdk-contract.md §3; RHY-277 observed ChatGPT compatibility (2026-09-12); https://modelcontextprotocol.io/specification/draft/server/utilities/caching'

/** Inspect only resource results; never forward envelope metadata to the model.
 * Stable MCP does not inherit draft requirements. See contract §3 / RHY-277. */
export function checkResourceEnvelope(result: Record<string, unknown>, options: {uri: string; host: HostProfile; protocolVersion?: string}): Finding[] {
  if ('error' in result || result.resultType === 'input_required') return []
  const findings: Finding[] = []
  const observedHost = options.host === 'chatgpt'
  const context = `${options.host}; negotiated protocol ${options.protocolVersion ?? 'unknown'}; ${observedHost ? 'observed host compatibility, failing incident negotiation unrecorded' : 'draft applicability unverified'}`
  const add = (rule: string, severity: Finding['severity'], message: string, hint: string) => findings.push({rule, severity, target: options.uri, message: `${message} (${context})`, hint, source})
  const missing = result.ttlMs === undefined || result.cacheScope === undefined
  if (!observedHost && missing) add('resource/cache-applicability', 'info', 'Required cache hints are not established for this protocol/host; no draft-only presence failure is inferred.', 'Verify the selected real host before treating a local resource read as accepted.')
  const severity = observedHost ? 'fail' : 'warn'
  if ((result.ttlMs !== undefined || observedHost) && !(typeof result.ttlMs === 'number' && Number.isInteger(result.ttlMs) && result.ttlMs >= 0)) {
    add('resource/cache-ttl', severity, 'result.ttlMs is missing or is not a nonnegative integer.', 'Set result.ttlMs to a nonnegative integer in milliseconds; 0 requests immediate staleness.')
  }
  if ((result.cacheScope !== undefined || observedHost) && !['private', 'public'].includes(result.cacheScope as string)) {
    add('resource/cache-scope', severity, 'result.cacheScope is missing or invalid.', 'Set result.cacheScope to private for caller-specific data; use public only after verifying the response is safe to share.')
  }
  const misplaced: string[] = []
  const inspect = (value: unknown, prefix: string) => {
    if (!value || typeof value !== 'object') return
    for (const key of ['ttlMs', 'cacheScope']) if (key in value) misplaced.push(`${prefix}.${key}`)
  }
  inspect(result._meta, 'result._meta')
  if (Array.isArray(result.contents)) result.contents.forEach((content, i) => {
    inspect(content, `result.contents[${i}]`)
    if (content && typeof content === 'object') inspect(content._meta, `result.contents[${i}]._meta`)
  })
  if (misplaced.length) add('resource/cache-placement', severity, `Cache hints are misplaced at ${misplaced.join(', ')}.`, 'Place cache hints directly on result, alongside contents; content and _meta fields do not satisfy envelope requirements.')
  if (result.cacheScope === 'public') add('resource/cache-public-review', 'warn', 'result.cacheScope is public; safe sharing cannot be established from this response.', 'Verify that contents are identical across callers and contain no private data. Otherwise use private; never use cache hints as access control.')
  return findings
}
