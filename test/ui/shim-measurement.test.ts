import {expect, it} from 'vitest'
import {buildShimScript} from '../../src/lib/simulate/widget/shim.js'

it('refreshes clipping telemetry when the host shrinks without resizing widget content', () => {
  const messages: Array<{method: string; params: {height: number}}> = []
  const listeners = new Map<string, () => void>()
  const window = {parent: {postMessage: (message: typeof messages[number]) => messages.push(message)}, addEventListener: (name: string, listener: () => void) => listeners.set(name, listener)}
  const document = {readyState: 'complete', body: {}, documentElement: {scrollHeight: 240, style: {setProperty() {}}, setAttribute() {}}}
  class ResizeObserver {
    constructor(private callback: () => void) {}
    observe() {this.callback()}
  }
  new Function('window', 'document', 'ResizeObserver', buildShimScript())(window, document, ResizeObserver)
  expect(messages.at(-1)).toMatchObject({method: 'apprhythm/measure', params: {height: 240}})
  document.documentElement.scrollHeight = 140
  listeners.get('resize')!()
  expect(messages.at(-1)).toMatchObject({method: 'apprhythm/measure', params: {height: 140}})
  const count = messages.length
  listeners.get('resize')!()
  expect(messages).toHaveLength(count)
})
