import {describe, expect, it} from 'vitest'

import {formatToolResultForModel, serializeMcpContent} from '../../src/lib/simulate/messages.js'

describe('serializeMcpContent', () => {
  it('joins text parts and summarises binary parts', () => {
    const out = serializeMcpContent([
      {type: 'text', text: 'hello'},
      {type: 'image', mimeType: 'image/png', data: 'AAAA'.repeat(100)},
      {type: 'audio', mimeType: 'audio/wav', data: 'AAAA'},
      {type: 'resource', resource: {uri: 'file:///x', mimeType: 'text/plain', text: 'inline resource text'}},
      {type: 'resource', resource: {uri: 'file:///bin', mimeType: 'application/octet-stream', blob: 'AAAA'}},
      {type: 'resource_link', uri: 'ui://widget/x.html'},
    ])
    expect(out).toContain('hello')
    expect(out).toContain('[image: image/png, ~300 bytes]')
    expect(out).toContain('[audio: audio/wav')
    expect(out).toContain('inline resource text')
    expect(out).toContain('[resource: file:///bin, application/octet-stream]')
    expect(out).toContain('[resource link: ui://widget/x.html]')
    expect(out).not.toContain('AAAAAAAA')
  })

  it('handles strings, null and legacy {text} parts', () => {
    expect(serializeMcpContent('plain')).toBe('plain')
    expect(serializeMcpContent(null)).toBe('')
    expect(serializeMcpContent([{text: 'legacy'}])).toBe('legacy')
  })
})

describe('formatToolResultForModel', () => {
  it('emits narration then structuredContent JSON, never _meta', () => {
    const s = formatToolResultForModel({
      content: [{type: 'text', text: 'Saved.'}],
      structuredContent: {ok: true},
      isError: false,
      ...({_meta: {secret: 'x'}} as object),
    })
    expect(s).toBe('Saved.\n\n{"ok":true}')
    expect(s).not.toContain('secret')
  })

  it('dedupes when content and structuredContent are the same JSON', () => {
    expect(formatToolResultForModel({content: [{type: 'text', text: '{"a":1}'}], structuredContent: {a: 1}, isError: false})).toBe('{"a":1}')
  })

  it('falls back sensibly', () => {
    expect(formatToolResultForModel({content: [], structuredContent: {a: 1}, isError: false})).toBe('{"a":1}')
    expect(formatToolResultForModel({content: [{type: 'text', text: 'only'}], isError: false})).toBe('only')
    expect(formatToolResultForModel({content: [], isError: true})).toBe('Error: tool returned no content')
    expect(formatToolResultForModel({content: [], isError: false})).toBe('')
  })
})
