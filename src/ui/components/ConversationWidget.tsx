import {useEffect, useState, type CSSProperties, type RefObject} from 'react'
import type {HostOptions, WidgetInstance} from '../api/client'
import {WidgetFrame} from './WidgetFrame'

/** Keep one iframe in the conversation tree. The dedicated view changes its
 * visual position only: reparenting/remounting an iframe can reset a live app. */
export function ConversationWidget({widget, options, inline, visible, target}: {
  widget: WidgetInstance; options: HostOptions; inline: boolean; visible: boolean; target: RefObject<HTMLDivElement | null>
}) {
  const [bounds, setBounds] = useState<CSSProperties>({visibility: 'hidden'})
  useEffect(() => {
    if (inline || !visible || !target.current) return
    const element = target.current
    const measure = () => {
      const rect = element.getBoundingClientRect()
      const viewport = element.closest('.inspector-content')?.getBoundingClientRect()
      const clipTop = viewport ? Math.max(0, viewport.top - rect.top) : 0
      const clipBottom = viewport ? Math.max(0, rect.bottom - viewport.bottom) : 0
      setBounds({clipPath: `inset(${clipTop}px 0 ${clipBottom}px 0)`, position: 'fixed', left: rect.left, top: rect.top, width: rect.width, height: rect.height, overflow: 'auto', zIndex: 2})
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true) }
  }, [inline, visible, target])
  return <div className={`conversation-widget${inline ? '' : ' conversation-widget--dedicated'}`} style={{...(inline ? {} : bounds), display: visible ? undefined : 'none'}}>
    <div className="message-label">Widget · {widget.toolName}</div>
    {widget.lifecycle === 'error' ? <p role="alert">{widget.error ?? 'Could not load widget.'}</p> : <WidgetFrame widget={widget} hostOptions={options} />}
  </div>
}
