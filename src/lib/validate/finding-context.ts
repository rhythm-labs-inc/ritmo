import type {Finding, HostProfile} from './types.js'

/** Presentation categories describe the rule's evidence and intended review target, not connection health. */
export function findingContext(finding: Finding, host: HostProfile = 'chatgpt'): {scope: string; artifact: string; reference: string} {
  const rule = finding.rule
  const local = /^(config|submission)\//.test(rule) || rule === 'directory/listing' || /^(app|submission)\./.test(finding.target)
  let scope = 'MCP contract / toolkit guidance'
  if (rule.startsWith('transport/')) scope = 'HTTP transport observation'
  else if (['directory/standard-ui-keys', 'directory/window-openai'].includes(rule)) scope = 'MCP Apps compatibility'
  else if (rule.startsWith('directory/')) scope = host === 'mcp-apps' ? 'Claude directory' : 'Claude directory guidance (advisory on ChatGPT)'
  else if (rule.startsWith('submission/') || (['tool/annotations-present', 'tool/security-schemes'].includes(rule) || (rule === 'tool/output-schema' && finding.message === 'no outputSchema'))) scope = 'ChatGPT submission'
  else if (rule.startsWith('config/')) scope = 'Local project readiness'
  else if (rule.startsWith('manifest/')) scope = 'Manifest comparison'
  return {
    scope,
    artifact: local ? 'local project configuration (ritmo.yaml or legacy apprhythm.yaml)' : rule.startsWith('manifest/') ? 'saved manifest and current endpoint' : 'remote endpoint metadata or response',
    reference: finding.source?.startsWith('§') ? `docs/apps-sdk-contract.md ${finding.source}` : finding.source ?? 'toolkit rule',
  }
}

export function validationProfileLabel(host: HostProfile = 'chatgpt'): string {
  return host === 'mcp-apps' ? 'MCP Apps compatibility + Claude directory review' : 'ChatGPT compatibility + submission review'
}
