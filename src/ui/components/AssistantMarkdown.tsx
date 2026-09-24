import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** Model output is untrusted: render Markdown, never embedded HTML or remote images. */
export function AssistantMarkdown({content}: {content: string}) {
  return <Markdown
    remarkPlugins={[remarkGfm]}
    skipHtml
    urlTransform={url => /^https?:\/\//i.test(url) ? url : ''}
    components={{
      a: ({href, children}) => href ? <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> : <span>{children}</span>,
      img: ({alt}) => <span>{alt}</span>,
      table: ({children}) => <div className="message-table"><table>{children}</table></div>,
    }}
  >{content}</Markdown>
}
