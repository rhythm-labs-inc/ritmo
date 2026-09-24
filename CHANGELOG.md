# Changelog

## 0.2.0-rc.1 — 2026-09-24 (prerelease)

Published on [npm](https://www.npmjs.com/package/@rhythm-labs-inc/ritmo) as `@rhythm-labs-inc/ritmo@0.2.0-rc.1`, with a [GitHub prerelease](https://github.com/rhythm-labs-inc/ritmo/releases/tag/v0.2.0-rc.1). See the [installation guide](docs/installation.md#install-the-release-candidate).

**Included in this release**

- Discover and call MCP tools, inspect resources, and validate metadata and transport behaviour.
- Try conversations and widgets in the local browser simulator using your OpenAI API key.
- Preview standalone widgets with fixture data, themes, and viewport controls.
- Save reviewed smoke tests and replay YAML scenarios.
- Connect with custom headers or OAuth, including browser sign-in, refresh, and secure credential storage.
- Compare metadata snapshots and export draft submission materials.
- Use `ritmo.yaml`, `RITMO_*`, and `.ritmo/`, with compatibility for older AppRhythm projects and credentials.

**Acceptance completed**

Lenny's Data was tested with bearer authentication and OAuth, including tool discovery, simulation, and replay. GitHub OAuth was tested with a registered client, resource reads, and installed CLI validation. Local widget theme and viewport controls were also checked. These results cover the tested services and flows; use the same acceptance checks with your own server.

**Known limitations**

- The simulator approximates host behaviour. Test your app in its target host before submitting.
- Model answers can misrepresent source content even when tool checks pass. Review important claims against the returned results. See [simulation](docs/simulation.md#answer-rendering-sources-and-usage).
- Submission validation covers part of the portal requirements. See the [documented differences](docs/apps-sdk-contract.md#8-openai-submission) before preparing a final submission.

Ritmo-owned source uses the [MIT license](LICENSE). Bundled dependency notices are in [NOTICE](NOTICE).
