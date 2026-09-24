const SENSITIVE_KEYS = /token|apikey|authorization|password|secret/i

/** Human diagnostics must not echo credentials embedded in a rejected URL. */
export function redactCredentialUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>]+/g, (value) => {
    try {
      const url = new URL(value)
      let changed = false
      if (url.username || url.password) { url.username = 'redacted'; url.password = ''; changed = true }
      for (const key of url.searchParams.keys()) {
        if (/token|key|auth|secret|password|signature|credential/i.test(key)) { url.searchParams.set(key, 'redacted'); changed = true }
      }
      return changed ? url.href : value
    } catch { return value }
  })
}

export function redactSensitiveFields(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj

  if (Array.isArray(obj)) {
    return obj.map((item) => redactSensitiveFields(item))
  }

  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.test(key)) {
      result[key] = '[REDACTED]'
    } else {
      result[key] = redactSensitiveFields(value)
    }
  }

  return result
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.test(key)
}
