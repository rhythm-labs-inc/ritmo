import type {HealthReport} from '../../lib/validate/health'
const labels = {'tool-call': 'Tool call', 'resource-response': 'Resource response', 'local-render': 'Local render', 'real-host-render': 'Real-host render', 'first-interaction': 'First interaction'}
export function HealthPanel({health}: {health?: HealthReport}) {
  if (!health) return null
  return <section className="widget-diagnostics"><h3>Observed health</h3><p>{health.endpoint} · Server revision: {health.revision}</p><dl>{Object.entries(health.stages).map(([stage, state]) => <div key={stage}><dt>{labels[stage as keyof typeof labels]}</dt><dd>{state}</dd></div>)}</dl>{health.observations.filter(o => o.state === 'fail').map((o, i) => <p key={i}>{o.stage} · {o.template ?? o.tool}: {o.detail}</p>)}<p>Local checks do not establish real-host rendering or approval.</p></section>
}
