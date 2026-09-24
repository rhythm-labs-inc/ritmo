import type {ToolCallResult} from '../mcp/client.js'

export interface SourceReference {title: string; url: string | null; excerpts?: string[]}
export interface AnswerFinding {sourceTitle: string; message: string}

/** Bounded inspection of model-visible structured records, including JSON-in-text MCP results. */
export function sourceReferences(result: Pick<ToolCallResult, 'content' | 'structuredContent'>): SourceReference[] {
  const found = new Map<string, SourceReference>()
  let remaining = 5000
  let excerptBudget = 30_000
  function visit(value: unknown, depth: number): void {
    if (depth > 10 || remaining-- <= 0) return
    if (typeof value === 'string' && value.length <= 1_000_000 && /^\s*[[{]/.test(value)) {
      try {visit(JSON.parse(value), depth + 1)} catch { /* ordinary text */ }
    } else if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1)
    } else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>
      if (typeof record.title === 'string' && record.title.trim() && record.title.length <= 1000) {
        const rawUrl = record.source_url ?? record.sourceUrl ?? record.url
        const url = typeof rawUrl === 'string' && /^https?:\/\//i.test(rawUrl) ? rawUrl : null
        // Copy whole, bounded excerpts only: truncation could discard a qualification.
        // These are source data, not verified claims or instructions (contract §4, RHY-334).
        const candidates = [record.snippet, record.excerpt,
          ...(Array.isArray(record.snippets) ? record.snippets.slice(0, 5).map(entry => typeof entry === 'string' ? entry : entry?.text) : [])]
        const complete = [...new Set(candidates.filter((text): text is string => typeof text === 'string' && text.trim().length > 0 && text.length <= 6000))].slice(0, 5)
        const key = JSON.stringify([record.title.trim(), url, complete])
        if (!found.has(key)) {
          const excerpts = complete.filter(text => {
            if (text.length > excerptBudget) return false
            excerptBudget -= text.length
            return true
          })
          const ref: SourceReference = {title: record.title.trim(), url, ...(excerpts.length ? {excerpts} : {})}
          found.set(key, ref)
        }
      }
      for (const [key, entry] of Object.entries(record)) {
        if (key !== '_meta') visit(entry, depth + 1)
      }
    }
  }
  visit(result.content, 0)
  visit(result.structuredContent, 0)
  return [...found.values()]
}

/** A conservative diagnostic, not a semantic fact checker or proof that an answer is grounded. */
export function checkSourceLinks(answer: string, sources: SourceReference[]): AnswerFinding[] {
  const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
  const lines = answer.split('\n')
  const sections: Array<{line: number; source?: SourceReference}> = []
  for (let i = 0; i < lines.length; i++) {
    const matches = sources.filter(source => normalize(lines[i]).includes(normalize(source.title)))
    if (matches.length) sections.push({line: i, source: matches.length === 1 ? matches[0] : undefined})
  }
  const findings: AnswerFinding[] = []
  for (let i = 0; i < sections.length; i++) {
    const {line, source} = sections[i]
    if (!source) continue
    const block = lines.slice(line, sections[i + 1]?.line ?? lines.length).join('\n')
    const urls: string[] = block.match(/https?:\/\/[^\s<>"'\])]+/gi) ?? []
    if (urls.some(url => url.replace(/[.,;:]+$/, '') !== source.url)) {
      findings.push({sourceTitle: source.title, message: source.url
        ? `The answer section for “${source.title}” includes a link different from that source's returned URL. Review its attribution.`
        : `No URL was returned for “${source.title}”, but its answer section includes a link. Review its attribution.`})
    }
  }
  return findings
}
