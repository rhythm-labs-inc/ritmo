import {useEffect, useMemo, useRef} from 'react'

import {injectMcpAppsSentinel, injectShim} from '../../lib/simulate/widget/shim'
import {type BridgeRequest, type HostOptions, type WidgetInstance, postBridge, postWidgetMounted} from '../api/client'
import {widgetFrameLayout} from './widget-frame-layout.js'

interface WidgetFrameProps {
  bridge?: typeof postBridge
  onMounted?: typeof postWidgetMounted
  widget: WidgetInstance
  /** Host behaviours; defaults mirror the real host. */
  hostOptions?: HostOptions
}

const DEFAULT_OPTIONS: HostOptions = {host: 'chatgpt', echoSetGlobals: true, clipToIntrinsicHeight: true, displayMode: 'inline', theme: 'light', viewport: 'desktop', inlineMaxHeight: 480}

function maxHeightFor(o: HostOptions): number {
  return o.displayMode === 'fullscreen' ? 2000 : o.displayMode === 'pip' ? 640 : o.inlineMaxHeight
}

const DEFAULT_FRAME_HEIGHT = 240

/**
 * The sandboxed iframe that hosts a widget, plus the browser half of the host bridge:
 *  - iframe → parent: JSON-RPC requests over postMessage are proxied to POST /api/widget/bridge
 *    and the response is posted back to the iframe.
 *  - parent → iframe: the `window.openai` shim (src/lib/simulate/widget/shim.ts) is prepended to
 *    template/inline HTML with the initial globals embedded, so widgets can read
 *    window.openai.toolOutput synchronously at boot. After load an `ui/init` notification repeats
 *    them (for raw-postMessage widgets) and `ui/setGlobals` follows on changes; the shim turns
 *    both into `openai:set_globals` events. Local-URL widgets can't be injected — they only get the
 *    notifications.
 *
 * Sandbox: allow-scripts allow-forms, no allow-same-origin (opaque origin), so targetOrigin must be '*'.
 */
export function WidgetFrame({widget, hostOptions, bridge = postBridge, onMounted = postWidgetMounted}: WidgetFrameProps) {
  const opts = hostOptions ?? DEFAULT_OPTIONS
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const loadedRef = useRef(false)

  // Bridge: listen for JSON-RPC from THIS iframe only
  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe) return

    async function onMessage(ev: MessageEvent) {
      if (!iframe || ev.source !== iframe.contentWindow) return
      const data = ev.data as Partial<BridgeRequest> | undefined
      if (!data || data.jsonrpc !== '2.0' || typeof data.method !== 'string') return

      // Notifications (no id) are fire-and-forget; requests get a response
      const isRequest = data.id !== undefined && data.id !== null
      const request: BridgeRequest = {
        jsonrpc: '2.0',
        id: isRequest ? (data.id as string | number) : `n-${Date.now()}`,
        method: data.method,
        params: data.params,
      }
      const response = await bridge(request)
      if (isRequest) {
        iframe.contentWindow?.postMessage(response, '*')
      }
    }

    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [widget.id])

  // Push globals to the iframe when their VALUE changes (session polling yields fresh object
  // identities every tick; comparing by JSON avoids spamming openai:set_globals).
  const globalsKey = JSON.stringify([widget.toolOutput, widget.toolResponseMetadata, widget.widgetState, opts.displayMode, opts.theme, opts.viewport, opts.echoSetGlobals, opts.inlineMaxHeight])
  const lastPushedKey = useRef<string | null>(null)
  useEffect(() => {
    if (!loadedRef.current) return
    if (lastPushedKey.current === globalsKey) return
    lastPushedKey.current = globalsKey
    pushGlobals(iframeRef.current, widget, opts, 'ui/setGlobals')
  }, [globalsKey])

  function onLoad() {
    loadedRef.current = true
    lastPushedKey.current = globalsKey
    pushGlobals(iframeRef.current, widget, opts, 'ui/init')
    void onMounted()
  }

  // Height policy (docs/apps-sdk-contract.md §6 "height clipping"):
  //  - clip on:  the frame is exactly the last notifyIntrinsicHeight (or a default) — like ChatGPT;
  //  - clip off: the frame grows to the measured content height (lenient host).
  // Either way, cap at maxHeight for the display mode.
  const cap = maxHeightFor(opts)
  const wanted = opts.clipToIntrinsicHeight
    ? (widget.intrinsicHeight ?? DEFAULT_FRAME_HEIGHT)
    : (widget.measuredHeight ?? widget.intrinsicHeight ?? DEFAULT_FRAME_HEIGHT)
  const height = Math.max(80, Math.min(wanted, cap))
  const overflow = widget.measuredHeight !== undefined && widget.measuredHeight > height + 2

  // Template/inline HTML gets the shim prepended with the mount-time globals baked in.
  const srcDoc = useMemo(
    () => widget.source.type === 'local'
      ? undefined
      : opts.host === 'mcp-apps'
        ? injectMcpAppsSentinel(widget.source.content)
        : injectShim(widget.source.content, {
        globals: {
          toolInput: widget.toolInput,
          toolOutput: widget.toolOutput ?? null,
          toolResponseMetadata: widget.toolResponseMetadata ?? null,
          toolResult: widget.toolResult ?? null,
          widgetState: widget.widgetState,
          displayMode: opts.displayMode,
          theme: opts.theme,
          maxHeight: maxHeightFor(opts),
          userAgent: {device: {type: opts.viewport === 'mobile' ? 'mobile' : 'desktop'}, capabilities: {hover: opts.viewport !== 'mobile', touch: opts.viewport === 'mobile'}},
        },
        echoSetWidgetState: opts.echoSetGlobals,
      }),
    // Rebuild the document per instance and per host profile; later changes flow via notifications.
    [widget.id, opts.host],
  )

  const common = {
    ref: iframeRef,
    className: `widget-iframe widget-iframe--${opts.displayMode}`,
    sandbox: 'allow-scripts allow-forms',
    title: `Widget: ${widget.toolName}`,
    onLoad,
    style: {height: `${height}px`, backgroundColor: opts.theme === 'light' ? '#ffffff' : '#0b1110'},
  }

  const frame = widget.source.type === 'local'
    ? <iframe key={widget.id} {...common} src={widget.source.content} />
    : <iframe key={widget.id} {...common} srcDoc={srcDoc} />

  return (
    <div
      className={`widget-frame-wrap widget-frame-wrap--${opts.viewport} widget-frame-wrap--${opts.displayMode}`}
      style={widgetFrameLayout(opts.viewport)}
    >
      {frame}
      {overflow && (
        <div className="widget-clip-overlay" title="The widget's content is taller than the frame. In ChatGPT the frame is sized by notifyIntrinsicHeight; anything below is clipped.">
          ✂ clipped: content {widget.measuredHeight}px, frame {height}px{opts.clipToIntrinsicHeight ? (widget.intrinsicHeight === undefined ? ' — widget never called notifyIntrinsicHeight' : ` — last notifyIntrinsicHeight ${widget.intrinsicHeight}px`) : ` — capped at maxHeight ${cap}px`}
        </div>
      )}
    </div>
  )
}

function pushGlobals(iframe: HTMLIFrameElement | null, widget: WidgetInstance, opts: HostOptions, method: 'ui/init' | 'ui/setGlobals') {
  const mobile = opts.viewport === 'mobile'
  if (opts.host === 'mcp-apps') {
    // Standard MCP Apps notifications (docs/apps-sdk-contract.md §9)
    const win = iframe?.contentWindow
    if (!win) return
    if (method === 'ui/init') {
      win.postMessage({jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: {arguments: widget.toolInput}}, '*')
      win.postMessage({jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: widget.toolResult ?? {content: [], structuredContent: widget.toolOutput ?? undefined, _meta: widget.toolResponseMetadata}}, '*')
    } else {
      win.postMessage({jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: widget.toolResult ?? {content: [], structuredContent: widget.toolOutput ?? undefined, _meta: widget.toolResponseMetadata}}, '*')
    }
    win.postMessage({jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: {
      theme: opts.theme, displayMode: opts.displayMode, platform: mobile ? 'mobile' : 'web',
      deviceCapabilities: {touch: mobile, hover: !mobile}, containerDimensions: {maxHeight: maxHeightFor(opts)},
    }}, '*')
    return
  }
  iframe?.contentWindow?.postMessage(
    {
      jsonrpc: '2.0',
      method,
      params: {
        toolName: widget.toolName,
        toolInput: widget.toolInput,
        toolOutput: widget.toolOutput ?? null,
        toolResponseMetadata: widget.toolResponseMetadata ?? null,
        toolResult: widget.toolResult ?? null,
        widgetState: widget.widgetState,
        displayMode: opts.displayMode,
        theme: opts.theme,
        maxHeight: maxHeightFor(opts),
        userAgent: {device: {type: mobile ? 'mobile' : 'desktop'}, capabilities: {hover: !mobile, touch: mobile}},
        hostOptions: {echoSetGlobals: opts.echoSetGlobals},
      },
    },
    '*',
  )
}
