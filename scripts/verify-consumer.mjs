import {createHash} from 'node:crypto'
import {execFile, spawn} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdtemp, mkdir, readFile, writeFile, rename, rm} from 'node:fs/promises'
import {createServer} from 'node:net'
import {fileURLToPath} from 'node:url'
import path from 'node:path'

const exec = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const workspace = await mkdtemp('/tmp/ritmo-public-consumer-')
const children = []
const env = {...process.env, RITMO_NO_KEYCHAIN: '1', RITMO_OPENAI_API_KEY: '', NO_COLOR: '1'}
const report = {name: pkg.name, version: pkg.version, checks: [], model_calls: 0}
async function run(command, args, cwd = workspace, overrides = {}) {
  return exec(command, args, {cwd, env: {...env, ...overrides}, maxBuffer: 8 * 1024 * 1024})
}
async function fixture(broken = false, overrides = {}) {
  const child = spawn(process.execPath, [path.join(root, 'examples/notes/server.mjs'), '--port', '0', ...(broken ? ['--broken'] : [])], {env: {...env, ...overrides}, stdio: ['ignore', 'pipe', 'pipe']})
  children.push(child)
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error('Example did not start')), 10_000)
    child.once('error', reject)
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Example exited before startup')) })
    child.stdout.on('data', (chunk) => { output += String(chunk); if (output.includes('\n')) {clearTimeout(timer); resolve(JSON.parse(output.split('\n')[0]).url)} })
  })
}
async function freePort() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}
try {
  const packDirectory = path.join(workspace, 'pack'); await mkdir(packDirectory)
  const packed = JSON.parse((await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', packDirectory], root)).stdout)[0]
  const contents = JSON.parse(await readFile(path.join(root, 'RELEASE-CONTENTS.json'), 'utf8'))
  const allowed = new Set([...contents.files.map((f) => f.path), 'package.json', 'RELEASE-CONTENTS.json'])
  for (const file of packed.files) if (!allowed.has(file.path)) throw new Error('Unexpected tarball file: ' + file.path)
  for (const file of allowed) if (!packed.files.some((entry) => entry.path === file)) throw new Error('Missing tarball file: ' + file)
  report.tarball = {name: packed.filename, integrity: packed.integrity, shasum: packed.shasum, files: packed.files.length}
  await writeFile(path.join(workspace, 'package.json'), JSON.stringify({name: 'ritmo-independent-consumer', version: '0.0.0', private: true, type: 'module'}))
  await run('npm', ['install', path.join(packDirectory, packed.filename), '--no-audit', '--fund=false'])
  const packageRoot = path.join(workspace, 'node_modules', pkg.name)
  for (const file of contents.files) if (createHash('sha256').update(await readFile(path.join(packageRoot, file.path))).digest('hex') !== file.sha256) throw new Error('Installed content hash mismatch: ' + file.path)
  const bin = path.join(packageRoot, 'bin/run.js')
  const cli = (args, cwd = workspace, overrides = {}) => run(process.execPath, [bin, ...args], cwd, overrides)
  for (const alias of ['ritmo', 'apprhythm']) {
    const result = await run(path.join(workspace, 'node_modules/.bin', alias), ['--help'])
    if (!result.stdout.includes('validate') || /\b(?:openapi|launch-package|readiness|reference|pilot|workspace)\b/.test(result.stdout)) throw new Error('Unexpected public CLI help surface')
  }
  report.checks.push('exact tarball allowlist and installed content hashes', 'clean native install', 'ritmo/apprhythm aliases')
  const url = await fixture()
  const discovery = await cli(['mcp', '--server', url, '--list-tools'])
  if (!discovery.stdout.includes('list_notes')) throw new Error('Example tool was not discovered')
  const validation = JSON.parse((await cli(['validate', '--server', url, '--no-probe', '--host', 'mcp-apps', '--json'])).stdout)
  if (validation.summary.fail !== 0) throw new Error('Expected a passing metadata baseline')
  const broken = await fixture(true)
  try { await cli(['validate', '--server', broken, '--no-probe', '--host', 'mcp-apps', '--json']); throw new Error('Broken example passed') }
  catch (error) {
    if (error.code !== 1 || !JSON.parse(error.stdout).findings.some((f) => f.rule === 'directory/title-and-hints' && f.severity === 'fail')) throw error
  }
  report.checks.push('no-model discovery', 'passing metadata baseline', 'intentional directory hint failure/exit 1')
  const secured = await fixture(false, {RITMO_EXAMPLE_KEY: 'synthetic-consumer-key'})
  await cli(['init', '--server-url', secured, '--skip-check', '--no-interactive'])
  const freshConfig = await readFile(path.join(workspace, 'ritmo.yaml'), 'utf8')
  if (!freshConfig.includes(secured)) throw new Error('Fresh canonical config missing')
  await cli(['config', 'set', 'server.url', secured, '--skip-check', '--no-interactive'])
  await cli(['auth', 'mcp', '--header-env', 'X-API-Key=RITMO_EXAMPLE_KEY', '--json'], workspace, {RITMO_EXAMPLE_KEY: 'synthetic-consumer-key'})
  const call = await cli(['mcp', '--call', 'list_notes', '--args', '{}'], workspace, {RITMO_EXAMPLE_KEY: 'synthetic-consumer-key'})
  if (!call.stdout.includes('synthetic') || call.stdout.includes('synthetic-consumer-key')) throw new Error('Environment-only authentication failed or leaked')
  await readFile(path.join(workspace, '.ritmo/identity.json'), 'utf8')
  await rename(path.join(workspace, 'ritmo.yaml'), path.join(workspace, 'apprhythm.yaml'))
  const legacyConfig = await run(path.join(workspace, 'node_modules/.bin/apprhythm'), ['config', 'show', '--json'])
  if (JSON.parse(legacyConfig.stdout).server.url !== secured) throw new Error('Legacy alias/config fallback failed')
  await rename(path.join(workspace, 'apprhythm.yaml'), path.join(workspace, 'ritmo.yaml'))
  report.checks.push('canonical setup/config editing and .ritmo identity', 'legacy config through installed apprhythm alias', 'environment-only MCP header credentials')
  await writeFile(path.join(workspace, 'engine.mjs'), `import {McpClient,runSuite,loadTestSuite} from ${JSON.stringify(pkg.name)};
const client=new McpClient({serverUrl:${JSON.stringify(url)}});
try {await client.connect();const result=await runSuite({suite:await loadTestSuite(${JSON.stringify(path.join(packageRoot, 'examples/notes/smoke.yaml'))}),filePath:'public-fixture',mcpClient:client,tools:await client.listTools(),createProvider:()=>({sendInitial:async()=>({content:null,toolCalls:[{id:'1',name:'list_notes',arguments:{}}]}),sendToolResults:async(results)=>{if(JSON.stringify(results).includes('uiOnly'))throw new Error('Widget metadata leaked to model');return {content:'Two synthetic notes.',toolCalls:[]}}})});if(result.cases.some(c=>c.outcome!=='pass'))throw new Error('Replay failed');console.log('Public engine replay passed with a scripted provider')} finally {await client.close()}`)
  await run(process.execPath, ['engine.mjs'])
  report.checks.push('versioned public engine import', 'shared replay engine with scripted provider', 'widget metadata excluded from model')
  const port = await freePort()
  const ui = spawn(process.execPath, [bin, 'widget', path.join(packageRoot, 'examples/notes/widget.html'), '--data', path.join(packageRoot, 'examples/notes/states.json'), '--port', String(port), '--no-open'], {cwd: packDirectory, env, stdio: 'ignore'})
  children.push(ui)
  let response
  for (let i = 0; i < 100; i++) {
    try { response = await fetch(`http://127.0.0.1:${port}`); if (response.ok) break } catch { /* startup */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (!response?.ok) throw new Error('Packed widget UI did not start')
  const html = await response.text()
  const asset = /src="(\/assets\/[^" ]+\.js)"/.exec(html)?.[1]
  if (!asset || !(await fetch(`http://127.0.0.1:${port}${asset}`)).ok) throw new Error('Packed UI asset unavailable')
  const session = await (await fetch(`http://127.0.0.1:${port}/api/session`)).json()
  if (!session.harness?.states.includes('notes')) throw new Error('Packed harness fixture did not mount')
  report.checks.push('packed local UI and assets', 'standalone widget fixture')
  // Exercise the installed conversation adapter without a browser or paid model.
  const adapter = path.join(packageRoot, 'dist/lib/server/fastify.js')
  await writeFile(path.join(workspace, 'simulator.mjs'), `import {createServer} from ${JSON.stringify(adapter)};
const config={version:1,app:{name:'consumer',description:'synthetic',icon:'',screenshots:[]},server:{url:${JSON.stringify(url)}},simulate:{model:'scripted',default_context:{locale:'en-US',timezone:'UTC'}},tests:[{file:'none'}]};
process.env.RITMO_OPENAI_API_KEY='synthetic-provider-placeholder';
const server=await createServer({port:0,config,simulator:{identity:null,hostOptions:{host:'mcp-apps'},createProvider:()=>({sendInitial:async()=>({content:null,toolCalls:[{id:'1',name:'list_notes',arguments:{}}]}),sendToolResults:async()=>({content:'Two synthetic notes.',toolCalls:[]})})}});
try {const response=await server.inject({method:'POST',url:'/api/chat',payload:{message:'Show notes'}});if(response.statusCode!==202)throw new Error('Chat rejected');let session;for(let i=0;i<100;i++){session=(await server.inject('/api/session')).json();if(session.status==='success'||session.status==='error')break;await new Promise(r=>setTimeout(r,25))}if(session.status!=='success'||session.messages.length!==2||!session.widget||session.trace[0]?.toolName!=='list_notes')throw new Error('Conversation/widget pipeline failed');if(session.health?.stages['real-host-render']==='pass')throw new Error('False host acceptance');console.log('Packed conversation adapter and widget pipeline passed')}finally{await server.close()}`)
  await run(process.execPath, ['simulator.mjs'])
  report.checks.push('packed conversation adapter and widget pipeline', 'real-host acceptance remains untested')
  await mkdir(path.join(root, 'artifacts'), {recursive: true})
  await writeFile(path.join(root, 'artifacts/consumer-verification.json'), JSON.stringify(report, null, 2) + '\n')
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
} finally {
  for (const child of children) child.kill('SIGTERM')
  await Promise.all(children.map((child) => child.exitCode !== null ? undefined : new Promise((resolve) => { child.once('exit', resolve); setTimeout(() => {child.kill('SIGKILL');resolve()}, 3000).unref() })))
  await rm(workspace, {recursive: true, force: true})
}
