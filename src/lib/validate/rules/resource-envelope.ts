import {checkResourceEnvelope} from '../resource-envelope.js'
import type {Rule} from '../types.js'

export const RESOURCE_ENVELOPE_RULES: Rule[] = [
  ['resource/cache-ttl', 'Resource result TTL matches the selected host compatibility profile'],
  ['resource/cache-scope', 'Resource result cache scope matches the selected host compatibility profile'],
  ['resource/cache-placement', 'Resource cache hints are at result level'],
  ['resource/cache-public-review', 'Public resource caching needs caller-independence review'],
  ['resource/cache-applicability', 'Draft cache-hint applicability remains explicit'],
].map(([id, description]) => ({
  id, description, source: 'docs/apps-sdk-contract.md §3; RHY-277',
  applies: ctx => [...ctx.templates.values()].some(t => t.response),
  check: ctx => [...ctx.templates.values()].flatMap(t => t.response ? checkResourceEnvelope(t.response, {uri: t.uri, host: ctx.host ?? 'chatgpt', protocolVersion: ctx.server.protocolVersion}).filter(f => f.rule === id) : []),
}))
