import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {describe, expect, it} from 'vitest'
import {addHealthObservation, createHealth} from '../../src/lib/validate/health.js'
import {HealthPanel} from '../../src/ui/components/HealthPanel.js'
import {WidgetDiagnostics} from '../../src/ui/components/WidgetDiagnostics.js'

describe('observed health presentation', () => {
  it('keeps untested stages explicit alongside a successful local render', () => {
    const health = addHealthObservation(createHealth('http://localhost:3000/mcp'), {
      stage: 'local-render', state: 'pass', detail: 'Iframe mounted locally.',
    })
    const html = renderToStaticMarkup(createElement(HealthPanel, {health}))
    expect(html).toContain('Observed health')
    expect(html).toContain('Passed')
    expect(html.match(/Not tested/g)).toHaveLength(4)
    expect(html).toContain('Server revision')
    expect(html).toContain('unknown')
    expect(html).toContain('Local checks do not establish real-host rendering or approval.')
  })

  it('retains readable failure details after a later successful observation', () => {
    let health = addHealthObservation(createHealth('http://localhost:3000/mcp'), {
      stage: 'first-interaction', state: 'fail', detail: '<script>failure</script>',
    })
    health = addHealthObservation(health, {stage: 'first-interaction', state: 'pass', detail: 'Recovered.'})
    const html = renderToStaticMarkup(createElement(HealthPanel, {health}))
    expect(html).toContain('Failed')
    expect(html).toContain('Observed failures')
    expect(html).toContain('First interaction')
    expect(html).not.toContain('undefined')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;failure&lt;/script&gt;')
  })

  it('omits unavailable health and labels an empty bridge event list', () => {
    expect(renderToStaticMarkup(createElement(HealthPanel))).toBe('')
    const html = renderToStaticMarkup(createElement(WidgetDiagnostics, {events: []}))
    expect(html).toContain('Bridge events')
    expect(html).toContain('No widget events yet')
  })
})
