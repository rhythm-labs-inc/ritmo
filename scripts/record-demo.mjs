// Regenerate a factual terminal illustration from the local synthetic example.
import {execFile, spawn} from 'node:child_process'
import {promisify, stripVTControlCharacters} from 'node:util'
import {readFile, mkdir, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const exec = promisify(execFile)
const env = {...process.env, NO_COLOR: '1', RITMO_NO_KEYCHAIN: '1', RITMO_OPENAI_API_KEY: '', RITMO_NO_HISTORY: '1'}
const children = []
async function fixture(broken) {
  const child = spawn(process.execPath, ['examples/notes/server.mjs', '--port', '0', ...(broken ? ['--broken'] : [])], {cwd: root, env, stdio: ['ignore', 'pipe', 'inherit']})
  children.push(child)
  return new Promise((resolve, reject) => {
    let out = ''
    const timer = setTimeout(() => reject(new Error('Fixture startup timed out')), 10000)
    child.once('error', reject)
    child.stdout.on('data', chunk => { out += String(chunk); if (out.includes('\n')) {clearTimeout(timer);resolve(JSON.parse(out.split('\n')[0]).url)} })
  })
}
try {
  const url = await fixture(false)
  const broken = await fixture(true)
  const cli = args => exec(process.execPath, ['bin/run.js', ...args], {cwd: root, env})
  const inspection = await cli(['inspect', 'examples/notes/ritmo.yaml'])
  const discovery = await cli(['mcp', '--server', url, '--list-tools'])
  const good = JSON.parse((await cli(['validate', '--server', url, '--host', 'mcp-apps', '--no-probe', '--json'])).stdout)
  if (good.summary.fail !== 0) throw new Error('Baseline failed')
  let bad
  try { await cli(['validate', '--server', broken, '--host', 'mcp-apps', '--no-probe', '--json']); throw new Error('Broken fixture passed') }
  catch (error) { if (error.code !== 1) throw error; bad = JSON.parse(error.stdout) }
  const finding = bad.findings.find(f => f.rule === 'directory/title-and-hints' && f.severity === 'fail')
  if (!finding) throw new Error('Expected directory hint finding absent')
  const transcript = ['$ ritmo inspect examples/notes/ritmo.yaml', stripVTControlCharacters(inspection.stdout), '$ ritmo mcp --server "$MCP_URL" --list-tools', stripVTControlCharacters(discovery.stdout), '$ ritmo validate --server "$MCP_URL" --host mcp-apps --no-probe --json', JSON.stringify({summary: good.summary}, null, 2), 'exit: 0', '$ # Restart example with --broken; repeat validation', JSON.stringify(finding, null, 2), 'exit: 1'].join('\n').replaceAll(root, '$RITMO_SOURCE').replaceAll(url, '$MCP_URL').replaceAll(broken, '$BROKEN_MCP_URL')
  const demo = {package: JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version, evidence: 'synthetic MCP fixture; local CLI; no model or real-host acceptance', good: good.summary, intentionalFailure: finding, exitCodes: [0, 1]}
  const lines = ['RITMO  /  LOCAL MCP CHECKS', '', '$ ritmo mcp --server "$MCP_URL" --list-tools', ...stripVTControlCharacters(discovery.stdout).split('\n').filter(line => /list_notes|List notes|synthetic example/.test(line)).slice(0, 4), '', '$ ritmo validate --server "$MCP_URL" --host mcp-apps --no-probe --json', `Passing fixture: ${good.summary.pass} pass · ${good.summary.warn} warn · ${good.summary.fail} fail`, 'exit 0', '', '$ # Restart example with --broken; repeat validation', `${finding.rule}  [fail]`, finding.message, 'exit 1', '', 'Synthetic example · 0 model calls · actual-host acceptance not tested']
  const escape = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  const height = 92 + lines.length * 29
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${height}" viewBox="0 0 1200 ${height}" role="img" aria-label="Actual CLI fixture output: a passing metadata check followed by an intentional missing-annotations failure"><rect width="1200" height="${height}" rx="22" fill="#132720"/><g font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="19">${lines.map((line, i) => `<text x="38" y="${58 + i * 29}" fill="${i === 0 ? '#78dfb7' : line.includes('[fail]') || line === 'exit 1' ? '#ffae9f' : line.startsWith('$') ? '#9cbbe3' : '#e0eae5'}">${escape(line)}</text>`).join('')}</g></svg>`
  const assets = path.join(root, 'docs/assets'); await mkdir(assets, {recursive: true})
  await writeFile(path.join(assets, 'cli-session.svg'), svg)
  await writeFile(path.join(assets, 'cli-session.txt'), transcript)
  await writeFile(path.join(assets, 'demo-evidence.json'), JSON.stringify(demo, null, 2) + '\n')
  process.stdout.write('Recorded actual synthetic CLI checks and terminal illustration.\n')
} finally { for (const child of children) child.kill('SIGTERM') }
