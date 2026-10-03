import type {HealthReport, ObservationState} from '../../lib/validate/health'

const labels = {'tool-call': 'Tool call', 'resource-response': 'Resource response', 'local-render': 'Local render', 'real-host-render': 'Real-host render', 'first-interaction': 'First interaction'} as const
const statuses: Record<ObservationState, {label: string; icon: string}> = {
  pass: {label: 'Passed', icon: '✓'},
  fail: {label: 'Failed', icon: '×'},
  'not-tested': {label: 'Not tested', icon: '–'},
}

export function HealthPanel({health}: {health?: HealthReport}) {
  if (!health) return null
  const failures = health.observations.filter(observation => observation.state === 'fail')

  return (
    <section className="health-panel" aria-label="Observed health">
      <h3 className="diagnostics-header">Observed health</h3>
      <div className="health-body">
        <dl className="health-context">
          <div><dt>Endpoint</dt><dd>{health.endpoint || 'Not configured'}</dd></div>
          <div><dt>Server revision</dt><dd>{health.revision}</dd></div>
        </dl>
        <dl className="health-stages">
          {Object.entries(health.stages).map(([stage, state]) => (
            <div className="health-stage" key={stage}>
              <dt>{labels[stage as keyof typeof labels]}</dt>
              <dd className={`health-status health-status--${state}`}>
                <span aria-hidden="true">{statuses[state].icon}</span>
                {statuses[state].label}
              </dd>
            </div>
          ))}
        </dl>
        {failures.length > 0 && (
          <div className="health-failures">
            <h4>Observed failures</h4>
            <ul>
              {failures.map((observation, index) => (
                <li key={index}>
                  <strong>{labels[observation.stage]}</strong>
                  {(observation.template ?? observation.tool) && <code>{observation.template ?? observation.tool}</code>}
                  <p>{observation.detail}</p>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="health-note">Local checks do not establish real-host rendering or approval.</p>
      </div>
    </section>
  )
}
