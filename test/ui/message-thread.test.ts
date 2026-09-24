import {readFileSync} from 'node:fs'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {describe, expect, it} from 'vitest'
import {summarizeUsage} from '../../src/lib/simulate/usage.js'
import {MessageThread} from '../../src/ui/components/MessageThread.js'

const markdown = readFileSync(new URL('../fixtures/simulate/markdown-response.md', import.meta.url), 'utf8')
const render = (role: 'user' | 'assistant') => renderToStaticMarkup(createElement(MessageThread, {messages: [{role, content: markdown, timestamp: 0}], status: 'success'}))
describe('simulator Markdown', () => {
  it('renders assistant headings, emphasis, lists, tables, code and links', () => {
    const html = render('assistant')
    expect(html).toContain('<h2>Onboarding sources</h2>')
    expect(html).toContain('<strong>A practical guide</strong>')
    expect(html).toContain('<ol>')
    expect(html).toContain('<table>')
    expect(html).toContain('<pre>')
    expect(html).toContain('href="https://example.com/guide"')
    expect(html).toContain('rel="noreferrer noopener"')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('href="javascript:')
    expect(html).not.toContain('<img')
  })
  it('keeps user text literal and preserves widget placement', () => {
    expect(render('user')).toContain('**A practical guide**')
    const html = renderToStaticMarkup(createElement(MessageThread, {messages: [{role: 'user', content: 'first', timestamp: 0}, {role: 'assistant', content: '**answer**', timestamp: 1}], status: 'success', widgetMessageIndex: 0, widget: createElement('div', null, 'widget-placeholder')}))
    expect(html.indexOf('widget-placeholder')).toBeLessThan(html.indexOf('<strong>answer</strong>'))
  })
})

it('renders unavailable usage without a zero-cost claim', () => {
 const html = renderToStaticMarkup(createElement(MessageThread, {messages: [], status: 'error', usage: summarizeUsage([undefined])}))
 expect(html).toContain('token usage unavailable')
 expect(html).toContain('total cost unavailable')
 expect(html).not.toContain('estimated $0.000000')
})
