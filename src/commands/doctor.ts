import {McpClient} from '../lib/mcp/client.js'
import {authForServer} from '../lib/mcp/connection.js'
import {Args, Flags} from '@oclif/core'

import {RitmoCommand} from '../lib/cli/command.js'

import {ConfigLoadError, loadConfig} from '../lib/config-loader.js'
import {formatCliReport, formatJsonReport} from '../lib/validate/report.js'
import {summarize, type FailOn, shouldFail} from '../lib/validate/run.js'
import {collectTransport, transportFindings} from '../lib/validate/transport.js'
import {httpProbe, CHALLENGE_PATH} from '../lib/validate/context.js'
import {transportChallenge} from '../lib/validate/rules/submission.js'
import {VALIDATION_REPORT_VERSION, type Finding, type ValidationReport} from '../lib/validate/types.js'

const FAIL_ON_VALUES: FailOn[] = ['fail', 'warn', 'info', 'never']

export default class Doctor extends RitmoCommand {
  static override description = 'Transport + deploy smoke against any MCP URL (staging, prod, a tunnel): initialize, protocol negotiation, GET→SSE, CORS, DELETE, Origin, body bounds, error hygiene, templates, optional rate-limit hammer, dark-check. Uses matching MCP authentication from config when present.'

  static override examples = [
    '<%= config.bin %> doctor https://www.example.com/mcp/apps/v1',
    '<%= config.bin %> doctor https://staging.example.com/mcp/apps/v1 --hammer 30 --fail-on warn',
    '<%= config.bin %> doctor https://www.example.com/mcp/apps/v1 --expect-dark      # pre-launch: everything must 404',
    '<%= config.bin %> doctor http://localhost:3000/mcp/apps/v1 --challenge-token abc123 --json',
  ]

  static override args = {
    url: Args.string({description: 'MCP endpoint URL (defaults to server.url from ritmo.yaml if present)', required: false}),
  }

  static override flags = {
    json: Flags.boolean({description: 'Print the report as JSON'}),
    quiet: Flags.boolean({char: 'q', description: 'Only show failures and warnings'}),
    'fail-on': Flags.string({description: `Exit non-zero at this severity or worse: ${FAIL_ON_VALUES.join(', ')} (default: fail)`, default: 'fail', helpValue: 'LEVEL'}),
    hammer: Flags.integer({description: 'Send N concurrent initialize requests and check the rate-limit shape (429 + Retry-After, no 5xx)', helpValue: 'N'}),
    'expect-dark': Flags.boolean({description: 'Assert the endpoint is dark: every method must 404 (pre-launch check)'}),
    'challenge-token': Flags.string({description: 'Check https://<host>/.well-known/openai-apps-challenge serves exactly this token', helpValue: 'TOKEN'}),
    'skip-big-body': Flags.boolean({description: 'Skip the 1.5 MB body-bounds probe'}),
    timeout: Flags.integer({description: 'Per-request timeout in milliseconds (default: 8000)', default: 8000, helpValue: 'MS'}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Doctor)
    const failOn = flags['fail-on'] as FailOn
    if (!FAIL_ON_VALUES.includes(failOn)) this.error(`Unsupported --fail-on "${flags['fail-on']}". Use one of: ${FAIL_ON_VALUES.join(', ')}`, {exit: 1})

    let url = args.url
    let challengeToken = flags['challenge-token']
    let challengeHost: string | undefined
    if (!url || !challengeToken) {
      try {
        const config = await loadConfig(process.cwd())
        url ??= config.server.url
        challengeToken ??= config.submission?.challenge_token
        challengeHost = config.submission?.challenge_host
      } catch (err) {
        if (!(err instanceof ConfigLoadError)) throw err
      }
    }
    if (!url) this.error('Provide a URL: ritmo doctor <url> (or run in a directory with ritmo.yaml).', {exit: 1})

    if (!flags.json) this.human(`Doctor: ${url}${flags['expect-dark'] ? ' (expecting dark)' : ''}…`)
    const config = await loadConfig().catch((error) => {if (error instanceof ConfigLoadError) return undefined; throw error})
    const client = new McpClient({serverUrl: url, auth: authForServer(config, url)})
    const probes = await collectTransport(url, {fetch: client.fetch.bind(client), sanitize: client.sanitize.bind(client), timeoutMs: flags.timeout, hammer: flags.hammer, skipBigBody: flags['skip-big-body'] || flags['expect-dark']})
    const findings: Finding[] = transportFindings(probes, {expectDark: flags['expect-dark']})

    if (challengeToken && !flags['expect-dark']) {
      const host = challengeHost ?? new URL(url).host
      const probe = await httpProbe(`https://${host}${CHALLENGE_PATH}`, {timeoutMs: Math.min(flags.timeout, 5000)})
      const ctx = {serverUrl: url, server: {capabilities: {}}, probes: {challenge: probe}, tools: [], resources: [], templates: new Map(), config: {version: 1 as const, app: {name: '', description: '', icon: '', screenshots: []}, server: {url}, simulate: {model: '', default_context: {locale: '', timezone: ''}}, tests: [], submission: {challenge_token: challengeToken, showcase_prompts: [], test_cases: [], negative_test_cases: [], tools: {}, skills: [], country_availability: []}}}
      const f = transportChallenge.check(ctx)
      findings.push(...(f.length ? f : [{rule: transportChallenge.id, severity: 'pass' as const, target: probe.url, message: transportChallenge.description, source: transportChallenge.source}]))
    }

    // Add pass lines for rule ids that produced no finding, so the report reads like validate's
    const RULES = ['transport/initialize', 'transport/protocol-version', 'transport/sse-get', 'transport/cors', 'transport/delete', 'transport/origin', 'transport/body-bounds', 'transport/error-hygiene', 'transport/templates', ...(flags.hammer ? ['transport/rate-limit'] : [])]
    if (!flags['expect-dark'] && probes.initialize && !probes.initialize.error) {
      for (const id of RULES) {
        if (!findings.some((f) => f.rule === id)) findings.push({rule: id, severity: 'pass', target: url, message: id.replace('transport/', ''), source: '§1'})
      }
    }
    // stable order: by rule as listed
    const order = new Map([...RULES, 'transport/dark', 'transport/domain-challenge'].map((r, i) => [r, i]))
    findings.sort((a, b) => (order.get(a.rule) ?? 99) - (order.get(b.rule) ?? 99))

    const report: ValidationReport = {
      version: VALIDATION_REPORT_VERSION,
      serverUrl: url,
      toolCount: probes.toolCount ?? 0,
      templateCount: probes.templates?.length ?? 0,
      findings,
      summary: summarize(findings),
    }
    if (flags.json) this.log(formatJsonReport(report))
    else this.human(formatCliReport(report, {quiet: flags.quiet}))
    if (shouldFail(report, failOn)) this.exit(1)
  }
}
