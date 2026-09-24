// Keep the minimum in sync with package.json and the tested version in .nvmrc.
const [major, minor, patch] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && (minor < 23 || (minor === 23 && patch < 2)))) {
  process.stderr.write(`Ritmo requires Node 22.23.2 or newer; this terminal uses ${process.version}.\nFrom the checkout, run nvm install && nvm use, then retry.\n`)
  process.exit(1)
}
