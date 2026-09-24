# Contributing

Rhythm Labs Inc. maintains Ritmo. Contributions to the CLI, simulator, tests, and docs are welcome.

**Start with a clear problem**

Use [GitHub Issues](https://github.com/rhythm-labs-inc/ritmo/issues) to report a bug or discuss a change. Describe what you expected, what happened, and how to reproduce it. For security issues, use [private reporting](SECURITY.md).

**Set up the source checkout**

Use Node 22.23.2 or newer. From the checkout root:

```bash
npm ci
npm run build:all
npm run ci:quality
```

The automated checks use local fixtures and do not need a model API key.

**Make and test your change**

- Keep command parsing and output in `src/commands`; put reusable logic in `src/lib`.
- Use the shared tool loop for both the simulator and test runner.
- Cover behaviour changes with small fixtures. Keep credentials and customer data out of them.
- Update the relevant command or configuration docs with the code.
- Explain what changed and how you tested it in your pull request.

Read the [architecture guide](docs/architecture.md) to find the right module. When changing a validation rule or widget bridge, check the [host contract sources](docs/apps-sdk-contract.md) and record the source for the change.

**Licensing and maintenance**

Contributions must be yours to share under the [MIT license](LICENSE). Preserve applicable third-party notices; bundled notices are in [NOTICE](NOTICE).

Rhythm Labs Inc. handles releases, package access, support, security reports, and host-contract updates. Maintainers should follow the [release process](docs/releasing.md).
