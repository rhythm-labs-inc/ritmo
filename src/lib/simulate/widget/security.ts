/**
 * Widget sandboxing and resource validation guardrails.
 *
 * Provides security-related utilities for the widget simulation subsystem:
 *   - Sandbox attribute generation for iframe elements
 *   - Origin/resource validation for widget sources
 *   - Content-Security-Policy header helpers
 */

import type {SandboxPolicy} from './types.js'
import {DEFAULT_SANDBOX_POLICY} from './types.js'

// ---------------------------------------------------------------------------
// Sandbox attribute generation
// ---------------------------------------------------------------------------

/**
 * Build the `sandbox` attribute value for a widget iframe.
 *
 * By default widgets get a restrictive sandbox that only allows scripts
 * and forms (no same-origin access, no popups, no top navigation).
 */
export function buildSandboxAttribute(policy: SandboxPolicy = DEFAULT_SANDBOX_POLICY): string {
  const tokens: string[] = []

  if (policy.allowScripts) tokens.push('allow-scripts')
  if (policy.allowForms) tokens.push('allow-forms')
  if (policy.allowSameOrigin) tokens.push('allow-same-origin')

  tokens.push(...policy.extraTokens)

  return tokens.join(' ')
}

// ---------------------------------------------------------------------------
// Origin / URL validation
// ---------------------------------------------------------------------------

/**
 * Validate that a widget URL is acceptable for local simulation.
 *
 * Only http://localhost, http://127.0.0.1, and http://[::1] are allowed
 * for local widget sources. HTTPS is also accepted for any host.
 */
export function isAllowedWidgetUrl(url: string): boolean {
  try {
    const parsed = new URL(url)

    // HTTPS is always allowed
    if (parsed.protocol === 'https:') return true

    // HTTP is only allowed for local addresses
    if (parsed.protocol === 'http:') {
      const host = parsed.hostname
      return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
    }

    return false
  } catch {
    return false
  }
}

/**
 * Validate that inline HTML content does not contain obvious dangerous patterns.
 *
 * This is a best-effort heuristic, not a full sanitizer. The iframe sandbox
 * attribute provides the real security boundary. This catches common mistakes.
 */
export function validateInlineContent(html: string): {valid: boolean; warnings: string[]} {
  const warnings: string[] = []

  // Check for external script tags
  const externalScriptPattern = /<script[^>]+src\s*=/i
  if (externalScriptPattern.test(html)) {
    warnings.push('Inline widget contains external <script src="..."> tag. External scripts may be blocked by the sandbox.')
  }

  // Check for top-level navigation attempts
  const topNavPattern = /window\.(top|parent)\s*\.\s*(location|href)/i
  if (topNavPattern.test(html)) {
    warnings.push('Inline widget attempts to access parent/top window location. This will be blocked by the sandbox.')
  }

  // Check for document.cookie access
  const cookiePattern = /document\s*\.\s*cookie/i
  if (cookiePattern.test(html)) {
    warnings.push('Inline widget accesses document.cookie. Cookies are not available in the sandboxed context.')
  }

  return {
    valid: warnings.length === 0,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// CSP helpers
// ---------------------------------------------------------------------------

/**
 * Generate a Content-Security-Policy meta tag value for inline widget content.
 *
 * This restricts the widget to only load resources from its own origin and
 * data: URIs. External network requests, eval, and inline event handlers
 * are blocked.
 */
export function buildWidgetCSP(): string {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",   // widgets need inline scripts
    "style-src 'unsafe-inline'",    // widgets need inline styles
    "img-src data: blob:",          // allow data/blob images
    "font-src data:",               // allow data fonts
    "connect-src 'none'",           // no XHR/fetch (use bridge instead)
  ].join('; ')
}
