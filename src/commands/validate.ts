import {manifestFilePath} from '../lib/naming.js'
import {authForServer} from '../lib/mcp/connection.js'
import {readFile} from 'node:fs/promises'
import path from 'node:path'

import {Flags} from '@oclif/core'

import {RitmoCommand} from '../lib/cli/command.js'
import {BuilderExperience} from '../lib/cli/builder-experience.js'
import {recordValidation} from '../lib/cli/builder-history.js'

import {ConfigLoadError, loadConfig} from '../lib/config-loader.js'
import type {AppRhythmConfig} from '../lib/config-schema.js'
import {BlueprintLoadError, BlueprintProjectionError, loadPluginBlueprint, projectPluginBlueprint} from '../lib/blueprint/index.js'
import {currentValidationPolicyBundle, validationPolicyInfo} from '../lib/policy/index.js'
import {DEFAULT_TIMEOUT_MS, McpClient} from '../lib/mcp/client.js'
import {McpError} from '../lib/mcp/errors.js'
import {collectContext} from '../lib/validate/context.js'
import {formatCliReport, formatJsonReport, formatMatrixReport} from '../lib/validate/report.js'
import {parseManifest} from '../lib/manifest/snapshot.js'
import {ALL_RULES} from '../lib/validate/rules/index.js'
import {type FailOn, runRules, shouldFail} from '../lib/validate/run.js'
import {HOST_PROFILES, type HostProfile} from '../lib/validate/types.js'

const FAIL_ON_VALUES: FailOn[] = ['fail', 'warn', 'info', 'never']

export default class Validate extends RitmoCommand {
  static override description = 'Lint your MCP server against the ChatGPT Apps SDK submission checklist'

  static override examples = [
    '<%= config.bin %> validate',
    '<%= config.bin %> validate --server http://localhost:3000/mcp/apps/v1',
    '<%= config.bin %> validate --json > validate.json',
    '<%= config.bin %> validate --fail-on warn        # CI: also fail on warnings',
    '<%= config.bin %> validate --list-rules',
  ]

  static override flags = {
    server: Flags.string({
      description: 'MCP server URL (overrides server.url from ritmo.yaml)',
      helpValue: 'URL',
    }),
    blueprint: Flags.string({
      description: 'Use this Blueprint JSON/YAML revision instead of ritmo.yaml',
      helpValue: 'PATH',
    }),
    environment: Flags.string({
      description: 'With --blueprint, project this delivery environment (defaults to the first)',
      helpValue: 'NAME',
    }),
    json: Flags.boolean({
      description: 'Print the full report as JSON instead of the human summary',
    }),
    quiet: Flags.boolean({
      char: 'q',
      description: 'Only show failures and warnings',
    }),
    'fail-on': Flags.string({
      description: `Exit non-zero at this severity or worse: ${FAIL_ON_VALUES.join(', ')} (default: fail)`,
      default: 'fail',
      helpValue: 'LEVEL',
    }),
    skip: Flags.string({
      description: 'Rule id to skip (repeatable)',
      multiple: true,
      helpValue: 'RULE_ID',
    }),
    timeout: Flags.integer({
      description: `Per-request timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})`,
      default: DEFAULT_TIMEOUT_MS,
      helpValue: 'MS',
    }),
    'list-rules': Flags.boolean({
      description: 'Print every rule id with its description and exit',
    }),
    host: Flags.string({
      description: 'Host profile to validate for: chatgpt (default), mcp-apps (Claude connectors / MCP Apps standard), or all (matrix)',
      default: 'chatgpt',
      options: ['chatgpt', 'mcp-apps', 'all'],
      helpValue: 'PROFILE',
    }),
    probe: Flags.boolean({
      description: 'Run raw HTTP probes (SSE GET, .well-known challenge). Use --no-probe to skip',
      default: true,
      allowNo: true,
    }),
    hammer: Flags.integer({description: 'With probes: send N concurrent initialize requests and check the rate-limit shape', helpValue: 'N'}),
    'probe-tools': Flags.boolean({
      description: 'Call every tool that accepts {} (readOnly tools twice) and check the results\' contract (output-schema, structured-content, meta-leak, read-only honesty). Executes tools — opt-in',
    }),
    'challenge-token': Flags.string({
      description: 'Domain-verification token to check at https://<host>/.well-known/openai-apps-challenge (overrides submission.challenge_token)',
      helpValue: 'TOKEN',
    }),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(Validate)

    if (flags['list-rules']) {
      for (const r of ALL_RULES) {
        const hosts = r.hosts ? ` (${r.hosts.join(', ')} only)` : ''
        this.human(`${r.id.padEnd(36)} ${r.description}  [${r.source}]${hosts}`)
      }
      return
    }

    const failOn = flags['fail-on'] as FailOn
    if (!FAIL_ON_VALUES.includes(failOn)) {
      this.error(`Unsupported --fail-on value "${flags['fail-on']}". Use one of: ${FAIL_ON_VALUES.join(', ')}`, {exit: 1})
    }

    const unknownSkips = (flags.skip ?? []).filter((id) => !ALL_RULES.some((r) => r.id === id))
    if (unknownSkips.length > 0) {
      this.error(`Unknown rule id(s) in --skip: ${unknownSkips.join(', ')}. Run --list-rules to see valid ids.`, {exit: 1})
    }

    // Config is optional when --server is given; when present it enables config/* rules.
    const config = await this.resolveConfig(flags)

    const serverUrl = flags.server ?? config!.server.url
    const client = new McpClient({serverUrl, timeoutMs: flags.timeout, auth: authForServer(config, serverUrl)})
    const view = new BuilderExperience({enabled: !flags.json && !flags.quiet})

    try {
      view.start('Connect', 'Connecting to MCP server')
      await client.connect()
      view.finish('Connect')
      view.start('Discover', 'Reading tools, widgets and transport contracts')

      const ctx = await collectContext({
        client,
        serverUrl,
        config,
        probe: flags.probe,
        challengeToken: flags['challenge-token'],
        probeTimeoutMs: Math.min(flags.timeout, 5000),
        probeTools: flags['probe-tools'],
        hammer: flags.hammer,
      })
      view.finish('Discover')
      // "Since last snapshot": only when a manifest exists in cwd
      const previousManifestPath = manifestFilePath()
      try {
        const raw = await readFile(previousManifestPath, 'utf8')
        ctx.previousManifest = parseManifest(raw, previousManifestPath)
      } catch {
        // no snapshot → manifest/* rules don't apply
      }
      const hosts: HostProfile[] = flags.host === 'all' ? HOST_PROFILES : [flags.host as HostProfile]
      const policy = validationPolicyInfo(currentValidationPolicyBundle())
      const reports = hosts.map((host) => ({
        ...runRules({...ctx, host}, {rules: ALL_RULES, skip: flags.skip}),
        policy,
      }))
      view.journey()

      if (flags.json) {
        this.log(reports.length === 1 ? formatJsonReport(reports[0]) : JSON.stringify({serverUrl, hosts: reports}, null, 2))
      } else if (reports.length === 1) {
        this.human(formatCliReport(reports[0], {quiet: flags.quiet}))
      } else {
        this.human(formatMatrixReport(reports, {quiet: flags.quiet}))
      }
      if (!flags.json && !flags.quiet) {
        this.human(await recordValidation(reports, {
          serverUrl, config, host: flags.host, environment: flags.environment, policy,
          skip: [...(flags.skip ?? [])].sort(), probe: flags.probe, probeTools: flags['probe-tools'],
          hammer: flags.hammer, timeout: flags.timeout, challengeToken: flags['challenge-token'],
          previousManifest: ctx.previousManifest,
          rules: reports.map((r) => [...new Set(r.findings.map((f) => f.rule))].sort()),
        }))
      }

      if (reports.some((r) => shouldFail(r, failOn))) {
        this.exit(1)
      }
    } catch (err) {
      view.fail()
      view.dispose()
      if (err instanceof McpError) {
        const hint = err.hint ? `\n  Hint: ${err.hint}` : ''
        this.error(`[${err.category}] ${err.message}${hint}`, {exit: 1})
      }

      throw err
    } finally {
      view.dispose()
      await client.close()
    }
  }

  private async resolveConfig(flags: {blueprint?: string; environment?: string; server?: string}): Promise<AppRhythmConfig | undefined> {
    if (flags.blueprint) {
      try {
        const blueprint = await loadPluginBlueprint(path.resolve(process.cwd(), flags.blueprint))
        return projectPluginBlueprint(blueprint, {environment: flags.environment}).config
      } catch (error) {
        if (error instanceof BlueprintLoadError || error instanceof BlueprintProjectionError) {
          this.error(`[blueprint] ${error.message}${error.hint ? `\n  Hint: ${error.hint}` : ''}`, {exit: 1})
        }
        throw error
      }
    }

    try {
      return await loadConfig(process.cwd())
    } catch (error) {
      if (!(error instanceof ConfigLoadError)) throw error
      if (!flags.server) {
        this.error(
          `No --server flag provided and could not load ritmo.yaml: ${error.message}\n` +
          'Run `ritmo init` to create a config, provide --server <url>, or use --blueprint <path>.',
          {exit: 1},
        )
      }
      return undefined
    }
  }
}
