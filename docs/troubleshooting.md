# Troubleshooting

Find the symptom below, try the fix, and rerun the command. Run `ritmo COMMAND --help` to check its options.

| Symptom | Check |
|---|---|
| Wrong command set or version | Run `command -v ritmo`; use this checkout's `node /absolute/path/to/ritmo/bin/run.js`, or reinstall the selected tarball. |
| Node version error | Use Node >=22.23.2; `.nvmrc` selects the tested version. |
| Native keytar installation fails | Allow normal npm install scripts. Linux builds may require `libsecret-1-dev`, Python and a C++ build toolchain. Use a supported Node version before rebuilding. |
| No usable desktop keychain | Supply model keys or MCP headers through environment references; set `RITMO_NO_KEYCHAIN=1` when running that way. Saved OAuth logins need an OS keychain. |
| Configuration not found | Run from the folder containing `ritmo.yaml`, or run `ritmo init`. Example simulation/replay runs from `examples/notes`. |
| Both Ritmo and AppRhythm files exist | Back up both, keep the intended configuration/state, and move the other outside the project. See [migration](migration.md). |
| MCP HTTP 401 / missing reference | Configure `ritmo auth mcp` and set the referenced variable in the shell that starts Ritmo. Restart an already-running simulator after environment changes. |
| OAuth callback or registration failure | Check the exact redirect URI, callback port, advertised metadata, resource URL and client registration. Use explicit `--login`; cancel/retry if the port is busy. |
| OAuth issuer changed or refresh revoked | Clear the selected session and reconnect. Clearing locally does not revoke the remote account grant. |
| Smoke draft cannot be saved | Start a new simulator session, send one typed prompt, review and confirm the draft, and choose a filename that does not already exist. |
| Blank widget | Build UI assets, inspect browser/harness diagnostics, check resource MIME/CSP and choose the matching host profile. The notes example needs no external fonts or scripts. |
| Port busy | Stop the earlier process with Ctrl+C or choose `--port` for the harness/simulator/example. |
| Validation passes but production fails | Examine skipped/warning findings; repeat without `--no-probe`, and test in the real host. Simulator success is not host approval. |
| Prompt chooses no tool | Inspect descriptions/instructions and the trace. Model selection is nondeterministic and differs from ChatGPT routing; use explicit expected-tool assertions. |

Still stuck? [Get help or report a bug](../SUPPORT.md) with a small, redacted example. Include the installed package/Node versions, command, expected/actual result, host profile and a synthetic fixture where possible. Never attach access tokens, cookies, `.env`, keychain exports or private tool-result payloads.
