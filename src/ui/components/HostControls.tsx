import {type HostOptions, postHostOptions} from '../api/client'

interface HostControlsProps {
  options: HostOptions
  onChange: (next: HostOptions) => void
}

/**
 * Toggles for the host behaviours the simulator reproduces (docs/apps-sdk-contract.md §6),
 * so a builder can bisect a widget bug: set_globals echo, height clipping, display mode,
 * theme, viewport.
 */
export function HostControls({options, onChange}: HostControlsProps) {
  async function patch(p: Partial<HostOptions>) {
    try {
      onChange(await postHostOptions(p))
    } catch {
      // ignore; next poll will resync
    }
  }

  return (
    <div className="host-controls">
      <label title="chatgpt: inject window.openai; mcp-apps (Claude): standard ui/* JSON-RPC only — every window.openai access is logged as a host mismatch">
        host
        <select value={options.host} onChange={(e) => patch({host: e.target.value as HostOptions['host']})}>
          <option value="chatgpt">chatgpt</option>
          <option value="mcp-apps">mcp-apps (Claude)</option>
        </select>
      </label>
      <label title="Real ChatGPT re-dispatches openai:set_globals after the widget's own setWidgetState (slider-drag-death root cause)">
        <input type="checkbox" checked={options.echoSetGlobals} onChange={(e) => patch({echoSetGlobals: e.target.checked})} /> set_globals echo
      </label>
      <label title="Real ChatGPT sizes the iframe from notifyIntrinsicHeight; content that grows without notifying is clipped">
        <input type="checkbox" checked={options.clipToIntrinsicHeight} onChange={(e) => patch({clipToIntrinsicHeight: e.target.checked})} /> clip to intrinsic height
      </label>
      <label>
        mode
        <select value={options.displayMode} onChange={(e) => patch({displayMode: e.target.value as HostOptions['displayMode']})}>
          <option value="inline">inline</option>
          <option value="pip">pip</option>
          <option value="fullscreen">fullscreen</option>
        </select>
      </label>
      <label>
        theme
        <select value={options.theme} onChange={(e) => patch({theme: e.target.value as HostOptions['theme']})}>
          <option value="light">light</option>
          <option value="dark">dark</option>
        </select>
      </label>
      <label>
        viewport
        <select value={options.viewport} onChange={(e) => patch({viewport: e.target.value as HostOptions['viewport']})}>
          <option value="desktop">desktop</option>
          <option value="mobile">mobile (390px)</option>
        </select>
      </label>
    </div>
  )
}
