/**
 * `window.openai` shim injected into widget iframes.
 *
 * Real ChatGPT widgets code against the `window.openai` global; the postMessage
 * JSON-RPC bridge is the transport underneath. This module builds a script that
 * implements the documented API (docs/apps-sdk-contract.md §6) on top of our
 * bridge:
 *
 *   widget → host:  window.openai.callTool(...)   → postMessage {jsonrpc, id, method:'tools/call', …} → HostBridge
 *   host → widget:  `ui/init` / `ui/setGlobals` notifications → window.openai.* updated → `openai:set_globals` event
 *
 * Envelope shapes (verified 2026-08-17 against the Apps SDK reference and observed host behavior):
 *   - callTool() resolves with {status, call_tool_result, mcp_tool_result, ...bareResult}
 *   - toolResponseMetadata is {...result._meta, _meta: result._meta, status, call_tool_result, mcp_tool_result}
 *   Both are supersets so bare-result readers and ChatGPT-envelope readers both work.
 *
 * Host quirks reproduced by default (toggleable via ShimOptions, surfaced in RHY-189):
 *   - setWidgetState echo: the host re-dispatches `openai:set_globals` after the widget's own call.
 *
 * Unimplemented methods (requestModal, uploadFile, selectFiles, getFileDownloadUrl, setOpenInAppUrl)
 * are present as functions that post to the bridge and reject with "Unsupported bridge method" —
 * so a widget that uses them fails LOUDLY in the Events tab instead of silently.
 *
 * This file must stay dependency-free: it is imported by the Vite SPA bundle as well as by node.
 */

export interface ShimGlobals {
  toolInput?: Record<string, unknown>
  toolOutput?: Record<string, unknown> | null
  /** Result `_meta` (widget-only). The shim wraps it in the ChatGPT envelope. */
  toolResponseMetadata?: Record<string, unknown> | null
  /** Full MCP result of the mounting call, used to build the envelope. */
  toolResult?: Record<string, unknown> | null
  widgetState?: Record<string, unknown> | null
  theme?: 'light' | 'dark'
  displayMode?: 'inline' | 'pip' | 'fullscreen'
  maxHeight?: number
  locale?: string
  userAgent?: Record<string, unknown>
  safeArea?: Record<string, unknown>
  view?: string
}

export interface ShimOptions {
  globals?: ShimGlobals
  /** Re-dispatch `openai:set_globals` after the widget's own setWidgetState (host behaviour). Default true. */
  echoSetWidgetState?: boolean
}

export const DEFAULT_SHIM_GLOBALS: Required<Pick<ShimGlobals, 'theme' | 'displayMode' | 'maxHeight' | 'locale' | 'userAgent' | 'safeArea' | 'view'>> = {
  theme: 'light',
  displayMode: 'inline',
  maxHeight: 480,
  locale: 'en-US',
  userAgent: {device: {type: 'desktop'}, capabilities: {hover: true, touch: false}},
  safeArea: {insets: {top: 0, right: 0, bottom: 0, left: 0}},
  view: 'inline',
}

/** Build the ChatGPT-shaped `toolResponseMetadata` envelope from a result. */
export function buildResponseMetadataEnvelope(result: Record<string, unknown> | null | undefined, meta?: Record<string, unknown> | null): Record<string, unknown> {
  const m = (meta ?? (result?._meta as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>
  const full = result ?? {content: [], ...(m && Object.keys(m).length ? {_meta: m} : {})}
  return {
    ...m,
    _meta: m,
    status: full.isError ? 'error' : 'success',
    call_tool_result: full,
    mcp_tool_result: full,
  }
}

/** Build the ChatGPT-shaped `callTool` resolution envelope from a result. */
export function buildCallToolEnvelope(result: Record<string, unknown>): Record<string, unknown> {
  return {
    ...result,
    status: result.isError ? 'error' : 'success',
    call_tool_result: result,
    mcp_tool_result: result,
  }
}

/** The shim script source (without <script> tags). */
export function buildShimScript(options: ShimOptions = {}): string {
  const g = {...DEFAULT_SHIM_GLOBALS, ...(options.globals ?? {})}
  const initial = {
    toolInput: g.toolInput ?? {},
    toolOutput: g.toolOutput ?? null,
    toolResponseMetadata: buildResponseMetadataEnvelope(g.toolResult ?? null, g.toolResponseMetadata ?? null),
    widgetState: g.widgetState ?? null,
    theme: g.theme,
    displayMode: g.displayMode,
    maxHeight: g.maxHeight,
    locale: g.locale,
    userAgent: g.userAgent,
    safeArea: g.safeArea,
    view: g.view,
  }
  const echo = options.echoSetWidgetState ?? true

  // JSON embedded in a <script>: escape "</" so a stray "</script>" in data can't break out.
  const initialJson = JSON.stringify(initial).replace(/<\//g, '<\\/')

  return `(function(){
  if (window.openai && window.openai.__apprhythm) return;
  var G = ${initialJson};
  var ECHO = ${echo ? 'true' : 'false'};
  var pending = {};
  var seq = 0;
  var GLOBAL_KEYS = ['toolInput','toolOutput','toolResponseMetadata','widgetState','theme','displayMode','maxHeight','locale','userAgent','safeArea','view'];

  function post(method, params) {
    return new Promise(function (resolve, reject) {
      var id = 'oa-' + (++seq);
      pending[id] = {resolve: resolve, reject: reject};
      window.parent.postMessage({jsonrpc: '2.0', id: id, method: method, params: params || {}}, '*');
    });
  }
  function notify(method, params) {
    window.parent.postMessage({jsonrpc: '2.0', method: method, params: params || {}}, '*');
  }
  function envelope(result) {
    result = result || {};
    var out = {};
    for (var k in result) if (Object.prototype.hasOwnProperty.call(result, k)) out[k] = result[k];
    out.status = result.isError ? 'error' : 'success';
    out.call_tool_result = result;
    out.mcp_tool_result = result;
    return out;
  }
  function metaEnvelope(result) {
    result = result || {};
    var m = result._meta || {};
    var out = {};
    for (var k in m) if (Object.prototype.hasOwnProperty.call(m, k)) out[k] = m[k];
    out._meta = m;
    out.status = result.isError ? 'error' : 'success';
    out.call_tool_result = result;
    out.mcp_tool_result = result;
    return out;
  }
  function dispatchGlobals(changed) {
    try {
      window.dispatchEvent(new CustomEvent('openai:set_globals', {detail: {globals: changed}}));
    } catch (e) { /* very old engines */ }
  }
  // Theme: ChatGPT injects CSS variables into the widget document; values here are approximations
  // ([unverified] — docs/apps-sdk-contract.md §6). Widgets should still fall back to prefers-color-scheme.
  var THEMES = {
    light: {'--text-primary': '#0d0d0d', '--text-secondary': '#5d5d5d', '--surface-primary': '#ffffff', '--surface-secondary': '#f4f4f4', '--border-default': '#e3e3e3', 'color-scheme': 'light'},
    dark:  {'--text-primary': '#ececec', '--text-secondary': '#b4b4b4', '--surface-primary': '#212121', '--surface-secondary': '#2f2f2f', '--border-default': '#424242', 'color-scheme': 'dark'}
  };
  function applyTheme(theme) {
    if (typeof document === 'undefined' || !document.documentElement) return;
    var vars = THEMES[theme] || THEMES.light;
    var root = document.documentElement;
    for (var k in vars) {
      if (k === 'color-scheme') root.style.colorScheme = vars[k];
      else root.style.setProperty(k, vars[k]);
    }
    root.setAttribute('data-theme', theme);
  }
  // Report the document's natural height so the host can show clipping (harness telemetry).
  function startMeasuring() {
    if (typeof ResizeObserver === 'undefined' || typeof document === 'undefined') return;
    var last = -1;
    function measure() {
      var h = document.documentElement.scrollHeight;
      if (h !== last) { last = h; notify('apprhythm/measure', {height: h}); }
    }
    var ro = new ResizeObserver(measure);
    // Shrinking the host viewport can change scrollHeight without resizing the body.
    window.addEventListener('resize', measure);
    if (document.body) ro.observe(document.body);
    ro.observe(document.documentElement);
  }
  function applyGlobals(params) {
    if (!params || typeof params !== 'object') return;
    if (params.hostOptions && typeof params.hostOptions.echoSetGlobals === 'boolean') ECHO = params.hostOptions.echoSetGlobals;
    var changed = {};
    for (var i = 0; i < GLOBAL_KEYS.length; i++) {
      var k = GLOBAL_KEYS[i];
      if (!(k in params)) continue;
      var v = params[k];
      if (k === 'toolResponseMetadata' && params.toolResult) v = metaEnvelope(params.toolResult);
      if (JSON.stringify(openai[k]) === JSON.stringify(v)) continue;
      openai[k] = v;
      changed[k] = v;
      if (k === 'theme') applyTheme(v);
    }
    if (params.toolResult && !('toolResponseMetadata' in params)) {
      openai.toolResponseMetadata = metaEnvelope(params.toolResult);
      changed.toolResponseMetadata = openai.toolResponseMetadata;
    }
    if (Object.keys(changed).length > 0) dispatchGlobals(changed);
  }

  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.jsonrpc !== '2.0') return;
    if (d.id != null && pending[d.id]) {
      var p = pending[d.id];
      delete pending[d.id];
      if (d.error) {
        var err = new Error(d.error.message || 'bridge error');
        err.code = d.error.code;
        err.data = d.error.data;
        p.reject(err);
      } else {
        p.resolve(d.result);
      }
      return;
    }
    if (d.method === 'ui/init' || d.method === 'ui/setGlobals') applyGlobals(d.params);
  });

  var openai = {
    __apprhythm: true,
    toolInput: G.toolInput,
    toolOutput: G.toolOutput,
    toolResponseMetadata: G.toolResponseMetadata,
    widgetState: G.widgetState,
    theme: G.theme,
    displayMode: G.displayMode,
    maxHeight: G.maxHeight,
    locale: G.locale,
    userAgent: G.userAgent,
    safeArea: G.safeArea,
    view: G.view,

    setWidgetState: function (state) {
      openai.widgetState = state;
      post('ui/setWidgetState', {state: state}).catch(function () {});
      if (ECHO) setTimeout(function () { dispatchGlobals({widgetState: state}); }, 0);
    },
    callTool: function (name, args) {
      return post('tools/call', {name: name, arguments: args || {}}).then(envelope);
    },
    sendFollowUpMessage: function (opts) {
      var prompt = (opts && (opts.prompt || opts.message)) || (typeof opts === 'string' ? opts : '');
      return post('ui/sendFollowUpMessage', {prompt: prompt});
    },
    requestDisplayMode: function (opts) {
      var mode = (opts && opts.mode) || 'inline';
      return post('ui/requestDisplayMode', {mode: mode}).then(function (r) {
        var granted = (r && r.mode) || mode;
        openai.displayMode = granted;
        dispatchGlobals({displayMode: granted});
        return {mode: granted};
      });
    },
    requestClose: function () { return post('ui/requestClose', {}); },
    openExternal: function (opts) {
      var href = (opts && opts.href) || (typeof opts === 'string' ? opts : '');
      post('ui/openExternal', {href: href}).catch(function () {});
    },
    notifyIntrinsicHeight: function (h) { notify('ui/notifyIntrinsicHeight', {height: h}); },

    // Documented but not simulated: post so the Events tab shows a loud "Unsupported bridge method".
    requestModal: function (opts) { return post('ui/requestModal', opts || {}); },
    setOpenInAppUrl: function (opts) { return post('ui/setOpenInAppUrl', opts || {}); },
    uploadFile: function () { return post('ui/uploadFile', {}); },
    selectFiles: function () { return post('ui/selectFiles', {}); },
    getFileDownloadUrl: function (opts) { return post('ui/getFileDownloadUrl', opts || {}); }
  };
  window.openai = openai;
  // Older SDK builds looked for this alias.
  if (!window.oai) window.oai = openai;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { applyTheme(openai.theme); startMeasuring(); });
    } else {
      applyTheme(openai.theme);
      startMeasuring();
    }
  }
})();`
}

/**
 * Prepend the shim to a widget HTML document so it runs before any widget script.
 * Inserts right after <head> if present, else after <html>, else at the top.
 */
export function injectShim(html: string, options: ShimOptions = {}): string {
  const tag = `<script data-apprhythm-shim>${buildShimScript(options)}</script>`
  const headMatch = /<head[^>]*>/i.exec(html)
  if (headMatch) {
    const idx = headMatch.index + headMatch[0].length
    return html.slice(0, idx) + tag + html.slice(idx)
  }
  const htmlMatch = /<html[^>]*>/i.exec(html)
  if (htmlMatch) {
    const idx = htmlMatch.index + htmlMatch[0].length
    return html.slice(0, idx) + tag + html.slice(idx)
  }
  return tag + html
}

/**
 * mcp-apps host profile: NO window.openai. Instead a sentinel Proxy that reports every property
 * access to the host (`apprhythm/host-mismatch`) and returns undefined — so a widget that guards
 * `typeof window.openai.callTool === "function"` degrades gracefully, and the Events tab lists
 * exactly which ChatGPT-only APIs the widget touched. Also announces the host to the view via
 * `window.__apprhythmHost = "mcp-apps"`.
 */
export function buildMcpAppsSentinelScript(): string {
  return `(function(){
  if (window.__apprhythmHost) return;
  window.__apprhythmHost = 'mcp-apps';
  var seen = {};
  function report(prop) {
    if (seen[prop]) return; seen[prop] = true;
    try { window.parent.postMessage({jsonrpc: '2.0', method: 'apprhythm/host-mismatch', params: {api: 'window.openai', prop: String(prop)}}, '*'); } catch (e) {}
  }
  var sentinel = new Proxy({}, {
    get: function (_t, prop) { if (prop === '__apprhythmSentinel') return true; if (typeof prop === 'symbol') return undefined; report(prop); return undefined; },
    has: function (_t, prop) { report(prop); return false; },
    set: function () { return true; }
  });
  try { Object.defineProperty(window, 'openai', {get: function () { report('(object)'); return sentinel; }, configurable: true}); } catch (e) { window.openai = sentinel; }
})();`
}

/** Prepend the mcp-apps sentinel to a widget document. */
export function injectMcpAppsSentinel(html: string): string {
  const tag = `<script data-apprhythm-host="mcp-apps">${buildMcpAppsSentinelScript()}</script>`
  const headMatch = /<head[^>]*>/i.exec(html)
  if (headMatch) {
    const idx = headMatch.index + headMatch[0].length
    return html.slice(0, idx) + tag + html.slice(idx)
  }
  const htmlMatch = /<html[^>]*>/i.exec(html)
  if (htmlMatch) {
    const idx = htmlMatch.index + htmlMatch[0].length
    return html.slice(0, idx) + tag + html.slice(idx)
  }
  return tag + html
}
