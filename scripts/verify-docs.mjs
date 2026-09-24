import {readFile, lstat} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(path.join(root, 'SOURCE-MANIFEST.json'), 'utf8'))
const documents = manifest.source_files.map(f => f.path).filter(name => name.endsWith('.md'))
let links = 0
for (const name of documents) {
  const text = await readFile(path.join(root, name), 'utf8')
  const targets = [...text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g), ...text.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1])
  for (const target of targets) {
    if (/^[a-z]+:/i.test(target)) continue
    const [file, anchor] = target.split('#')
    const absolute = file ? path.resolve(root, path.dirname(name), decodeURIComponent(file)) : path.join(root, name)
    if (!absolute.startsWith(root + path.sep)) throw new Error(`Link escapes public source: ${name} → ${target}`)
    if (!(await lstat(absolute)).isFile()) throw new Error(`Missing document/image: ${name} → ${target}`)
    if (anchor && absolute.endsWith('.md')) {
      const headings = [...(await readFile(absolute, 'utf8')).matchAll(/^#{1,6}\s+(.+)$/gm)].map(match => match[1].toLowerCase().replace(/[^\p{L}\p{N}_\- ]/gu, '').replace(/ /g, '-'))
      if (!headings.includes(decodeURIComponent(anchor))) throw new Error(`Missing heading: ${name} → ${target}`)
    }
    links++
  }
}
process.stdout.write(`Verified ${links} local links across ${documents.length} Markdown documents.\n`)
