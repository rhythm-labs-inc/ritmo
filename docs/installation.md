# Install Ritmo

Use Node **22.23.2 or newer**. Ritmo runs as a CLI and local browser toolkit.

**Release status:** source is available on [GitHub](https://github.com/rhythm-labs-inc/ritmo). npm publication of `@rhythm-labs-inc/ritmo@0.2.0-rc.1` is still pending. Install from the public source checkout or build a tarball using the instructions below. The unscoped npm package `ritmo` is unrelated.

## Source checkout

**Build and link the CLI**

From the checkout root:

```bash
npm ci
npm run build:all
npm link
ritmo --help
```

`npm link` makes `ritmo` available from your app's folder. If you prefer not to change a global command, use `node /absolute/path/to/ritmo/bin/run.js` in its place.

**Start using it in your app**

Return to your app's project folder and follow the [quickstart](../README.md#start-using-ritmo-in-minutes). Ritmo reads configuration from the folder where you run the command.

## Packed installation

**Build an installable tarball**

From a clean source checkout:

```bash
npm ci
npm pack
```

This builds the CLI and browser assets, checks the package contents, and creates `rhythm-labs-inc-ritmo-0.2.0-rc.1.tgz`.

**Install the tarball in your app**

```bash
npm install /absolute/path/to/rhythm-labs-inc-ritmo-0.2.0-rc.1.tgz
npx --no-install ritmo --help
```

Use `npx --no-install ritmo` for subsequent commands when installed this way.

## Check the source and package

From the Ritmo source root:

```bash
npm run ci:quality
```

This runs build, test, lint, documentation, package-content, and installed-consumer checks. It uses local fixtures without paid model calls. Package verification results are saved in `artifacts/consumer-verification.json`.

For tests against your own MCP server, configure its authentication and your OpenAI key separately. See [authentication](authentication.md) and [simulation](simulation.md).

## Installation problems

Ritmo uses `keytar` for secure credential storage. Allow npm's normal install scripts. Linux builds may need `libsecret` development libraries, Python, and a C++ build toolchain; runtime keychain access needs a desktop secret service.

Environment variables can supply model keys and MCP headers when a keychain is unavailable. Persistent OAuth still needs the OS keychain. See [Troubleshooting](troubleshooting.md).
