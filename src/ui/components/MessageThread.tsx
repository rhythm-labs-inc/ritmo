import {formatUsage, type UsageSummary} from '../../lib/simulate/usage'
import {Fragment, useEffect, useRef, type ReactNode} from 'react'

import {AssistantMarkdown} from './AssistantMarkdown'

import type {SessionMessage} from '../api/client'

interface MessageThreadProps {
  usage?: UsageSummary
  widget?: ReactNode
  widgetMessageIndex?: number
  messages: SessionMessage[]
  status: string
  error?: string
  errorCategory?: string
}

export function MessageThread({usage, messages, status, error, errorCategory, widget, widgetMessageIndex}: MessageThreadProps) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({behavior: 'smooth'})
  }, [messages.length, status])

  if (messages.length === 0 && status === 'idle') {
    return (
      <div className="message-thread message-thread--empty">
        <p className="empty-state">Send a message to start simulating your ChatGPT App.</p>
      </div>
    )
  }

  return (
    <div className="message-thread">
      {messages.map((msg, i) => (
        <Fragment key={i}><div
          className={`message message--${msg.role}`}
        >
          <div className="message-label">{msg.role === 'user' ? (msg.origin === 'widget' ? 'You (via widget)' : 'You') : 'Assistant'}</div>
          <div className={`message-content${msg.role === 'assistant' ? ' message-markdown' : ''}`}>{msg.role === 'assistant' ? <AssistantMarkdown content={msg.content} /> : msg.content}</div>
          {msg.answerFindings?.length ? <div className="source-review"><strong>Source links need review</strong><ul>{msg.answerFindings.map((finding, index) => <li key={index}>{finding.message}</li>)}</ul></div> : null}
        </div>
        {i === widgetMessageIndex && widget}
        </Fragment>
      ))}

      {status === 'running' && (
        <div className="message message--assistant message--running">
          <div className="message-label">Assistant</div>
          <div className="message-content message-thinking">Thinking…</div>
        </div>
      )}

      {status === 'error' && error && (
        <div className="message message--error">
          <div className="message-label">Error{errorCategory ? ` [${errorCategory}]` : ''}</div>
          <div className="message-content">{error}</div>
        </div>
      )}

      {usage && usage.requests > 0 && <div className="model-usage" aria-label="Model usage">
        <p>{formatUsage(usage)}</p>
        {usage.pricingSources.length > 0 && <details><summary>Estimate details</summary><p>{usage.pricingSources.join('; ')}</p><p>Estimates cover reported requests, not an invoice or spending cap. Failed requests may have unreported usage.</p></details>}
      </div>}
      <div ref={bottomRef} />
    </div>
  )
}
