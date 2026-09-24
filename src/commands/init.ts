import {configFilePath} from '../lib/naming.js'
import {existsSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import path from 'node:path'

import {Flags} from '@oclif/core'

import {RitmoCommand} from '../lib/cli/command.js'

import {promptServerUrl, updateServerUrlText} from '../lib/config-setup.js'
import {McpError} from '../lib/mcp/errors.js'

const DEFAULT_CONFIG = `version: 1

app:
  name: "My App"                     # ≤ 30 chars (portal-enforced)
  subtitle: "One line, ≤ 30 chars"  # shown under the name in the app directory
  description: "What this app does"
  icon: "./assets/icon.png"          # 1024×1024 PNG, solid background
  screenshots:
    - "./assets/screenshots/main.png"
    - "./assets/screenshots/detail.png"
    - "./assets/screenshots/empty.png"
  # privacy_policy_url: "https://example.com/privacy"   # required for submission
  # terms_url: "https://example.com/terms"               # required for submission
  # company_url: "https://example.com"
  # support_url: "https://example.com/support"

server:
  url: "http://localhost:2091/mcp"

simulate:
  model: "gpt-4o-mini"
  default_context:
    locale: "en-US"
    timezone: "America/New_York"

tests:
  - file: "./tests/smoke.yaml"

# Everything the OpenAI submission portal asks for that the server can't tell us.
# "ritmo validate" checks it; "ritmo package" emits it. See docs/config.md.
submission:
  # challenge_token: "..."          # served at https://<host>/.well-known/openai-apps-challenge
  showcase_prompts: []              # up to 3
  test_cases: []                    # ≥ 5 of {scenario, prompt, tools: [..], expected}
  negative_test_cases: []           # ≥ 3 of {scenario, prompt, rationale}
  tools: {}                         # <tool_name>: {justifications: {readOnlyHint, destructiveHint, openWorldHint}}
  skills: []                        # {name, path, delivery: bundle|mcp-import}; path contains SKILL.md
  country_availability: []          # ISO 3166-1 alpha-2 country codes, e.g. [CA, US]
  # policy_attestations: {confirmed: true, confirmed_by: "Owner", confirmed_at: "2026-08-27T00:00:00Z"}
  # release_notes: {kind: initial, summary: "…", changes: "…", reviewer_notes: "…"}
`

export default class Init extends RitmoCommand {
  static override description = 'Initialize a new Ritmo project with ritmo.yaml'

  static override examples = [
    '<%= config.bin %> init',
    '<%= config.bin %> init --force',
  ]

  static override flags = {
    'server-url': Flags.string({description: 'MCP Streamable HTTP endpoint; checks connection unless --skip-check'}),
    'skip-check': Flags.boolean({description: 'Explicitly save the URL for later without connecting'}),
    'no-interactive': Flags.boolean({description: 'Never prompt; use --server-url for scripted setup'}),
    force: Flags.boolean({char: 'f', description: 'Overwrite existing ritmo.yaml'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(Init)
    const configPath = configFilePath(process.cwd())

    if (existsSync(configPath) && !flags.force) {
      this.error(
        `${path.basename(configPath)} already exists. Use --force to overwrite.`,
        {exit: 1},
      )
    }

    const overwriting = existsSync(configPath)

    try {
      const url = await promptServerUrl({url: flags['server-url'], skipCheck: flags['skip-check'], interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY && !flags['no-interactive']), report: (message) => this.human(message)})
      const content = updateServerUrlText(DEFAULT_CONFIG, url)
      if (configFilePath() !== configPath) throw new McpError('naming-conflict', 'Configuration selection changed during setup. Retry against the current file.')
      await writeFile(configPath, content, {encoding: 'utf8', flag: flags.force ? 'w' : 'wx'})
    } catch (error) { this.handleError(error) }

    if (overwriting) {
      this.human(`Overwrote existing ${path.basename(configPath)}`)
    } else {
      this.human(`Configuration set up and saved to ${path.basename(configPath)}`)
    }
  }

  private handleError(error: unknown): never {
    if (error instanceof McpError) this.error(`[${error.category}] ${error.message}\n  Hint: ${error.hint ?? 'Retry setup.'}`, {exit: 1})
    this.error('[config] Could not write ritmo.yaml. Check permissions and whether the file already exists.', {exit: 1})
  }
}
