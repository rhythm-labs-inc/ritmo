export type WidgetViewport = 'desktop' | 'mobile'

/**
 * Explicit frame dimensions keep the simulator's device selector visible and
 * measurable. The containing workspace owns available space; the frame owns
 * the device-sized cap inside it.
 */
export function widgetFrameLayout(viewport: WidgetViewport): {width: string; maxWidth: string} {
  return viewport === 'mobile'
    ? {width: '390px', maxWidth: '100%'}
    : {width: '100%', maxWidth: '760px'}
}
