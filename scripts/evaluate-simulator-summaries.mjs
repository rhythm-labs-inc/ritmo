#!/usr/bin/env node
// Opt-in live evaluation of the shared simulator using synthetic source snippets.
// Completion is not a semantic pass: review every answer against its saved rubric.
/* global AbortSignal, console */
import {createHash} from 'node:crypto'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {fileURLToPath, URL} from 'node:url'
import {parseArgs} from 'node:util'
import path from 'node:path'

const {values} = parseArgs({options: {
  live: {type: 'boolean', default: false},
  runs: {type: 'string', default: '1'},
  out: {type: 'string'},
}})
const root = fileURLToPath(new URL('../', import.meta.url))
const cases = JSON.parse(await readFile(new URL('../test/fixtures/simulate/summary-cases.json', import.meta.url), 'utf8'))
const runs = Number(values.runs)
if (!Number.isInteger(runs) || runs < 1 || runs > 3) throw new Error('--runs must be 1, 2 or 3.')
if (!values.live) {
  console.log(`No model calls made. Build, then use --live --out NEW_DIRECTORY [--runs 1..3] to run ${cases.length * runs} synthetic scenarios with gpt-4o-mini (up to four completion calls each; SDK retries may add requests). Review answers manually; there is no automatic accuracy grade.`)
} else {
  if (!values.out) throw new Error('--out NEW_DIRECTORY is required for live evidence.')
  const out = path.resolve(values.out)
  await mkdir(out, {recursive: false}) // Never overwrite an earlier evaluation.
  const {resolveCredential} = await import('../dist/lib/credentials/resolution.js')
  const {OpenAIProvider, composeSystemPrompt} = await import('../dist/lib/simulate/provider/openai.js')
  const {runHeadlessLoop} = await import('../dist/lib/simulate/headless-loop.js')
  const credential = await resolveCredential('openai')
  if (!credential) throw new Error('Configure an OpenAI credential through Ritmo or RITMO_OPENAI_API_KEY.')
  // Record the compiled prompt actually used, not a possibly newer source file.
  const prompt = composeSystemPrompt()
  await writeFile(path.join(out, 'inputs.json'), JSON.stringify({model: 'gpt-4o-mini', runs, prompt, promptSha256: createHash('sha256').update(prompt).digest('hex'), cases}, null, 2) + '\n')
  let failed = false
  for (const scenario of cases) {
    for (let run = 1; run <= runs; run++) {
      const provider = new OpenAIProvider({apiKey: credential.value, model: 'gpt-4o-mini', signal: AbortSignal.timeout(60_000)})
      let requests = 0
      let toolCalls = 0
      let usage
      const limited = async (operation) => {
        if (requests >= 4) throw new Error('Evaluation request limit reached.')
        requests++
        return operation()
      }
      let record
      try {
        const result = await runHeadlessLoop({
          provider: {
            sendInitial: (...args) => limited(() => provider.sendInitial(...args)),
            sendToolResults: (...args) => limited(() => provider.sendToolResults(...args)),
          },
          mcpClient: {callTool: async (name) => {
            if (name !== 'search_content') throw new Error('Only synthetic search is available.')
            toolCalls++
            return {content: [{type: 'text', text: JSON.stringify({results: scenario.results})}], isError: false}
          }},
          tools: [{name: 'search_content', description: 'Search the source archive and return snippets. The only available evidence is in these search results.', inputSchema: {type: 'object', properties: {query: {type: 'string'}}, required: ['query']}}],
          message: scenario.prompt,
          onUsage: (snapshot) => {usage = snapshot},
        })
        record = {id: scenario.id, run, status: toolCalls > 0 ? 'needs-semantic-review' : 'no-source-read', requests, toolCalls, answer: result.assistantResponse, review: scenario.review, usage: result.usage, linkFindings: result.answerFindings}
        if (toolCalls === 0) failed = true
      } catch {
        failed = true
        // Provider errors can carry request/authentication details. Do not persist them.
        record = {id: scenario.id, run, status: 'incomplete', requests, toolCalls, usage}
      }
      await writeFile(path.join(out, `${scenario.id}.${run}.json`), JSON.stringify(record, null, 2) + '\n')
      console.log(`${scenario.id} ${run}/${runs}: ${record.status}`)
    }
  }
  console.log(`Evidence: ${path.relative(root, out)}. Read every answer against its rubric; successful execution is not an accuracy grade.`)
  if (failed) process.exitCode = 1
}
