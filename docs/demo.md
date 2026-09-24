# Try the included example

## CLI: discover, pass, then fail

**Start the example server**

Install and build Ritmo using the first two steps in the [README quickstart](../README.md#start-using-ritmo-in-minutes). From the Ritmo source root:

```bash
npm run example
```

**List tools and validate**

Keep the server running. In a second terminal, from the same source root:

```bash
ritmo mcp --server http://127.0.0.1:2091/mcp --list-tools
ritmo validate --server http://127.0.0.1:2091/mcp --host mcp-apps --no-probe
```

You should see `list_notes` and no failing metadata findings. This first check skips transport probes. Review the warnings and skipped checks in the output.

**Try an intentional failure**

Stop the server with Ctrl+C and restart it with:

```bash
npm run example -- --broken
```

Repeat the validation command. It reports `directory/title-and-hints` and exits 1 because the broken example omits the read-only hint required by the Claude directory profile. Restart without `--broken` to restore the passing version.

## Local simulator UI: inspect both widget states

**Open the widget example**

From the Ritmo source root:

```bash
ritmo widget examples/notes/widget.html --data examples/notes/states.json --host mcp-apps
```

Choose **notes** or **empty**, change the theme and viewport, and inspect the bridge events. This preview needs neither a model key nor a running MCP server.

**Try a conversation**

Keep `npm run example` running in another terminal. From the source root:

```bash
ritmo auth set-key --provider openai
cd examples/notes
ritmo simulate --host mcp-apps
```

Enter **Show the example notes**. This uses your OpenAI API key and incurs provider charges. See [simulation and replay](simulation.md) for saving and running tests.

The CLI illustration above comes from [recorded output](assets/cli-session.txt) with a separate [evidence record](assets/demo-evidence.json). To regenerate it from built source, run `node scripts/record-demo.mjs`.
