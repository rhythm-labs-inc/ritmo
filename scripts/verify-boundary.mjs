import {createHash} from 'node:crypto'
import {readFile, readdir, writeFile, lstat} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(path.join(root, 'SOURCE-MANIFEST.json'), 'utf8'))
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const sourcePaths = new Set(manifest.source_files.map((f) => f.path))
const expectedDist = new Set(manifest.source_files.filter((f) => /^src\//.test(f.path) && !/^src\/ui\//.test(f.path) && f.path.endsWith('.ts')).flatMap((f) => ['.js', '.js.map', '.d.ts'].map((suffix) => f.path.replace(/^src\//, 'dist/').replace(/\.ts$/, suffix))))
async function walk(directory) {
  const result = []
  for (const entry of await readdir(path.join(root, directory), {withFileTypes: true})) {
    const name = path.posix.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error('Symlink in release tree: ' + name)
    if (entry.isDirectory()) result.push(...await walk(name))
    else result.push(name)
  }
  return result
}
for (const name of await walk('src')) if (!sourcePaths.has(name)) throw new Error('Unreviewed source: ' + name)
const built = await walk('dist')
for (const name of built) if (!expectedDist.has(name)) throw new Error('Unexpected compiled module: ' + name)
for (const name of expectedDist) if (!built.includes(name)) throw new Error('Missing compiled module: ' + name)
const commands = built.filter((name) => /^dist\/commands\/.*\.js$/.test(name)).map((name) => name.replace(/^dist\/commands\//, '').replace(/\.js$/, '')).sort()
if (JSON.stringify(commands) !== JSON.stringify([...manifest.commands].sort())) throw new Error('Command allowlist mismatch')
if (pkg.name !== '@rhythm-labs-inc/ritmo' || pkg.license !== 'MIT' || pkg.bin.ritmo !== pkg.bin.apprhythm) throw new Error('Package identity/license/compatibility mismatch')
if (JSON.stringify(pkg.files) !== JSON.stringify(manifest.package_files)) throw new Error('Tarball root allowlist mismatch')
for (const field of ['exports', 'dependencies', 'devDependencies', 'engines', 'bin']) if (JSON.stringify(pkg[field]) !== JSON.stringify(manifest[field])) throw new Error(`Package ${field} differs from reviewed boundary`)
if (manifest.template_files.length !== 0 || !sourcePaths.has(manifest.ui_entry)) throw new Error('Template/UI entry boundary mismatch')
const ui = await walk('dist-ui')
if (!ui.includes('dist-ui/index.html') || !ui.some((name) => /^dist-ui\/assets\/[^/]+\.js$/.test(name))) throw new Error('Simulator UI was not built')
for (const name of ui) if (!/^dist-ui\/(index\.html|assets\/[^/]+\.(?:js|css))$/.test(name)) throw new Error('Unreviewed UI asset: ' + name)
const index = await readFile(path.join(root, 'dist-ui/index.html'), 'utf8')
for (const match of index.matchAll(/(?:src|href)="\/(assets\/[^"]+)"/g)) if (!ui.includes('dist-ui/' + match[1])) throw new Error('Missing UI asset: ' + match[1])
const release = [...built, ...ui]
for (const directory of ['bin', 'examples', 'docs', 'schemas']) for (const name of await walk(directory)) {
  if (!sourcePaths.has(name)) throw new Error('Unreviewed release asset: ' + name)
  release.push(name)
}
for (const name of ['README.md', 'LICENSE', 'NOTICE', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SUPPORT.md', 'SECURITY.md']) { await lstat(path.join(root, name)); release.push(name) }
const files = []
for (const name of release.sort()) files.push({path: name, sha256: createHash('sha256').update(await readFile(path.join(root, name))).digest('hex')})
await writeFile(path.join(root, 'RELEASE-CONTENTS.json'), JSON.stringify({schema_version: 1, name: pkg.name, version: pkg.version, commands, files}, null, 2) + '\n')
process.stdout.write(`Verified ${commands.length} commands, ${built.length} compiled files and ${ui.length} UI assets.\n`)
