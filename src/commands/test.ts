import {Flags} from '@oclif/core'

import {RitmoCommand} from '../lib/cli/command.js'
import {BuilderExperience} from '../lib/cli/builder-experience.js'

import {ConfigLoadError, loadConfig} from '../lib/config-loader.js'
import {BlueprintLoadError, BlueprintProjectionError, loadPluginBlueprint, projectPluginBlueprint} from '../lib/blueprint/index.js'
import {CredentialError} from '../lib/credentials/errors.js'
import {resolveCredential} from '../lib/credentials/resolution.js'
import {McpClient} from '../lib/mcp/client.js'
import {McpError} from '../lib/mcp/errors.js'
import {IDENTITY_FLAG_DESCRIPTIONS, identityFromFlags} from '../lib/mcp/identity.js'
import {OpenAIProvider} from '../lib/simulate/provider/openai.js'
import {loadTestSuite, TestLoadError} from '../lib/test-runner/loader.js'
import {runSuite} from '../lib/test-runner/engine.js'
import {formatCliReport} from '../lib/test-runner/reporters/cli.js'
import {type DiscoveryReport, buildDiscoveryReport, formatDiscoveryReport} from '../lib/test-runner/reporters/discovery.js'
import {formatJUnitReport} from '../lib/test-runner/reporters/junit.js'
import {suiteAllPassed} from '../lib/test-runner/results.js'
import {readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'

const SUPPORTED_REPORTERS = ['cli', 'junit', 'discovery'] as const
type Reporter = (typeof SUPPORTED_REPORTERS)[number]

export default class Test extends RitmoCommand {
  static override description = 'Run interaction test suites against a live MCP server'

  static override examples = [
    '<%= config.bin %> test',
    '<%= config.bin %> test --file ./tests/smoke.yaml',
    '<%= config.bin %> test --blueprint ./ritmo.blueprint.yaml',
    '<%= config.bin %> test --reporter junit > results.xml',
  ]

  static override flags = {
    file: Flags.string({
      char: 'f',
      description: 'Path to a specific test YAML file (overrides ritmo.yaml test list; incompatible with --blueprint)',
      helpValue: 'PATH',
    }),
    blueprint: Flags.string({description: 'Use this Blueprint JSON/YAML revision instead of ritmo.yaml and test files', helpValue: 'PATH'}),
    environment: Flags.string({description: 'With --blueprint, project this delivery environment (defaults to the first)', helpValue: 'NAME'}),
    reporter: Flags.string({
      char: 'r',
      description: `Output reporter: ${SUPPORTED_REPORTERS.join(', ')} (default: cli)`,
      default: 'cli',
      helpValue: 'FORMAT',
    }),
    subject: Flags.string({description: IDENTITY_FLAG_DESCRIPTIONS.subject, helpValue: 'ID'}),
    'new-user': Flags.boolean({description: IDENTITY_FLAG_DESCRIPTIONS['new-user']}),
    'no-identity': Flags.boolean({description: IDENTITY_FLAG_DESCRIPTIONS['no-identity']}),
    runs: Flags.integer({description: 'Repeat every case N times (model non-determinism); a case passes only if every run passes. Shows pass rate / invocation rate', helpValue: 'N', default: 1}),
    'discovery-out': Flags.string({description: 'With --reporter discovery: also write the report JSON here (for --compare later)', helpValue: 'FILE'}),
    compare: Flags.string({description: 'With --reporter discovery: a previous --discovery-out JSON to show precision/recall deltas against', helpValue: 'FILE'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(Test)

    if (flags.blueprint && flags.file) {
      this.error('[blueprint] --blueprint and --file are incompatible. Remove --file to run the projected suite, or run the YAML suite without --blueprint.', {exit: 1})
    }

    // Validate reporter
    const reporter = flags.reporter as Reporter
    if (!SUPPORTED_REPORTERS.includes(reporter)) {
      this.error(
        `Unsupported reporter: "${reporter}". Supported values: ${SUPPORTED_REPORTERS.join(', ')}`,
        {exit: 1},
      )
    }

    // Load the legacy config/files or one in-memory Blueprint projection.
    let config: Awaited<ReturnType<typeof loadConfig>>
    const suites: Awaited<ReturnType<typeof loadTestSuite>>[] = []
    const resolvedPaths: string[] = []
    if (flags.blueprint) {
      try {
        const blueprint = await loadPluginBlueprint(path.resolve(process.cwd(), flags.blueprint))
        const projection = projectPluginBlueprint(blueprint, {environment: flags.environment})
        config = projection.config
        suites.push(projection.testSuite)
        resolvedPaths.push(`blueprint:${projection.blueprint.id}@${projection.blueprint.revision}`)
      } catch (error) {
        if (error instanceof BlueprintLoadError || error instanceof BlueprintProjectionError) {
          this.error(`[blueprint] ${error.message}${error.hint ? `\n  Hint: ${error.hint}` : ''}`, {exit: 1})
        }
        throw error
      }
    } else {
      try {
        config = await loadConfig(process.cwd())
      } catch (error) {
        if (error instanceof ConfigLoadError) {
          this.error(
            `Could not load ritmo.yaml: ${error.message}\n` +
            'Run `ritmo init` to create a config file, or use --blueprint <path>.',
            {exit: 1},
          )
        }
        throw error
      }

      const testFiles = flags.file ? [flags.file] : config.tests.map((test) => test.file)
      if (testFiles.length === 0) {
        this.error('No test files configured. Add entries under "tests:" in ritmo.yaml, use --file, or use --blueprint.', {exit: 1})
      }

      // Load and validate all test YAML files before connecting to MCP.
      for (const testFile of testFiles) {
        const resolvedPath = path.resolve(process.cwd(), testFile)
        resolvedPaths.push(resolvedPath)
        try {
          suites.push(await loadTestSuite(resolvedPath))
        } catch (error) {
          if (error instanceof TestLoadError) {
            this.error(`${error.message}${error.hint ? `\n  Hint: ${error.hint}` : ''}`, {exit: 1})
          }
          throw error
        }
      }
    }

    // Resolve credential
    const credential = await resolveCredential('openai')
    if (!credential) {
      this.error(
        '[missing-credential] No OpenAI API key configured.\n' +
        '  Hint: Run `ritmo auth set-key --provider openai` or set RITMO_OPENAI_API_KEY.',
        {exit: 1},
      )
    }

    const mcpClient = new McpClient({serverUrl: config.server.url, auth: config.server.auth})
    const identity = identityFromFlags(flags, config.simulate.default_context.locale)
    let allPassed = true
    const view = new BuilderExperience({enabled: reporter === 'cli'})

    try {
      view.start('Connect', 'Connecting to MCP server')
      await mcpClient.connect()
      view.finish('Connect')
      view.start('Discover', 'Discovering tools')
      const tools = await mcpClient.listTools()
      view.finish('Discover')
      const instructions = mcpClient.getServerInfo().instructions

      if (reporter === 'cli') {
        this.human(`MCP connected. Found ${tools.length} tool${tools.length === 1 ? '' : 's'}.`)
        this.human(`Running ${suites.length} test file${suites.length === 1 ? '' : 's'}…`)
      }

      // Run each test suite
      for (let i = 0; i < suites.length; i++) {
        const suite = suites[i]
        const resolvedPath = resolvedPaths[i]

        // Run the suite
        view.start('Test', 'Checking the experience')
        const result = await runSuite({
          suite,
          filePath: resolvedPath,
          createProvider: () => new OpenAIProvider({
            apiKey: credential.value,
            model: config.simulate.model,
            instructions,
          }),
          mcpClient,
          tools,
          identity,
          runs: flags.runs,
          onProgress: reporter === 'cli' ? ({completed, total, name}) => view.update(`Prompt scenarios ${completed}/${total} checked · ${name}`) : undefined,
        })
        view.finish('Test', suiteAllPassed(result))

        // Report
        if (reporter === 'junit') {
          process.stdout.write(formatJUnitReport(result))
        } else if (reporter === 'discovery') {
          const report = buildDiscoveryReport(result)
          let previous: DiscoveryReport | undefined
          if (flags.compare) {
            try {
              previous = JSON.parse(await readFile(path.resolve(process.cwd(), flags.compare), 'utf8')) as DiscoveryReport
            } catch (err) {
              this.warn(`Could not read --compare file: ${err instanceof Error ? err.message : String(err)}`)
            }
          }
          this.human(formatDiscoveryReport(report, previous))
          if (flags['discovery-out']) {
            await writeFile(path.resolve(process.cwd(), flags['discovery-out']), JSON.stringify(report, null, 2) + '\n', 'utf8')
            this.human(`wrote ${flags['discovery-out']}`)
          }
        } else {
          this.human(formatCliReport(result))
        }

        if (!suiteAllPassed(result)) {
          allPassed = false
        }
      }
      view.finish('Test', allPassed)
      view.journey()
    } catch (err) {
      view.fail()
      view.dispose()
      if (err instanceof McpError) {
        const hint = err.hint ? `\n  Hint: ${err.hint}` : ''
        this.error(`[${err.category}] ${err.message}${hint}`, {exit: 1})
      }

      if (err instanceof CredentialError) {
        const hint = err.hint ? `\n  Hint: ${err.hint}` : ''
        this.error(`[${err.category}] ${err.message}${hint}`, {exit: 1})
      }

      if (err instanceof Error) {
        this.error(`[api-failure] ${err.message}`, {exit: 1})
      }

      throw err
    } finally {
      view.dispose()
      await mcpClient.close()
    }

    if (!allPassed) {
      this.exit(1)
    }
  }
}
