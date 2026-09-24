/** Provider-reported token counts only. No prompts, credentials or tool payloads. */
export interface ModelUsage {
  model: string
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  totalTokens: number
  estimatedCostUsd: number | null
  pricingSource?: string
}
export interface UsageSummary {
  requests: number
  reportedRequests: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  totalTokens: number
  /** Null if any attempted request lacks usage or a supported price. */
  estimatedCostUsd: number | null
  knownCostUsd: number
  pricingSources: string[]
}
interface CompletionUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: {cached_tokens?: number} | null
}
const PRICING_SOURCE = 'https://developers.openai.com/api/docs/models/gpt-4o-mini (2026-09-17 standard text-token rates)'
const validCount = (value: number) => Number.isSafeInteger(value) && value >= 0

/** Standard text rates; unsupported models/service tiers remain unpriced. See docs/simulation.md. */
export function measureUsage(model: string, usage?: CompletionUsage, serviceTier?: string | null): ModelUsage | undefined {
  if (!usage || ![usage.prompt_tokens, usage.completion_tokens, usage.total_tokens].every(validCount)) return undefined
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0
  if (!validCount(cached) || cached > usage.prompt_tokens || usage.total_tokens !== usage.prompt_tokens + usage.completion_tokens) return undefined
  const priced = ['gpt-4o-mini', 'gpt-4o-mini-2024-07-18'].includes(model) && (!serviceTier || serviceTier === 'default')
  // Rate snapshot verified against official OpenAI documentation, 2026-09-17.
  const cost = ((usage.prompt_tokens - cached) * 0.15 + cached * 0.075 + usage.completion_tokens * 0.60) / 1_000_000
  return {model, inputTokens: usage.prompt_tokens, cachedInputTokens: cached, outputTokens: usage.completion_tokens, totalTokens: usage.total_tokens, estimatedCostUsd: priced ? cost : null, ...(priced ? {pricingSource: PRICING_SOURCE} : {})}
}

export function summarizeUsage(calls: Array<ModelUsage | undefined>): UsageSummary {
  const reported = calls.filter((usage): usage is ModelUsage => usage !== undefined)
  const sum = (field: 'inputTokens' | 'cachedInputTokens' | 'outputTokens' | 'totalTokens') => reported.reduce((n, usage) => n + usage[field], 0)
  const knownCostUsd = reported.reduce((n, usage) => n + (usage.estimatedCostUsd ?? 0), 0)
  return {requests: calls.length, reportedRequests: reported.length, inputTokens: sum('inputTokens'), cachedInputTokens: sum('cachedInputTokens'), outputTokens: sum('outputTokens'), totalTokens: sum('totalTokens'), knownCostUsd, estimatedCostUsd: reported.length === calls.length && reported.every(usage => usage.estimatedCostUsd !== null) ? knownCostUsd : null, pricingSources: [...new Set(reported.flatMap(usage => usage.pricingSource ? [usage.pricingSource] : []))]}
}

export function mergeUsage(summaries: Array<UsageSummary | undefined>): UsageSummary {
  const items = summaries.filter((item): item is UsageSummary => item !== undefined)
  const sum = (field: 'requests' | 'reportedRequests' | 'inputTokens' | 'cachedInputTokens' | 'outputTokens' | 'totalTokens' | 'knownCostUsd') => items.reduce((n, usage) => n + usage[field], 0)
  return {requests: sum('requests'), reportedRequests: sum('reportedRequests'), inputTokens: sum('inputTokens'), cachedInputTokens: sum('cachedInputTokens'), outputTokens: sum('outputTokens'), totalTokens: sum('totalTokens'), knownCostUsd: sum('knownCostUsd'), estimatedCostUsd: items.every(item => item.estimatedCostUsd !== null) ? sum('knownCostUsd') : null, pricingSources: [...new Set(items.flatMap(item => item.pricingSources))]}
}

export function formatUsage(usage: UsageSummary): string {
  const tokens = usage.reportedRequests === 0 && usage.requests > 0 ? 'token usage unavailable' : `${usage.inputTokens} input + ${usage.outputTokens} output tokens (${usage.cachedInputTokens} cached input)`
  const completeness = usage.reportedRequests < usage.requests ? ` · reported for ${usage.reportedRequests}/${usage.requests} requests; incomplete` : ''
  const cost = usage.estimatedCostUsd === null ? 'total cost unavailable' : `estimated $${usage.estimatedCostUsd.toFixed(6)} USD`
  return `Model usage: ${tokens}${completeness} · ${cost}`
}
