import {lstatSync} from 'node:fs'
import path from 'node:path'
import {McpError} from './mcp/errors.js'

/** Canonical presence wins even when empty; never revive an overridden legacy value. */
export function ritmoEnv(suffix: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[`RITMO_${suffix}`] ?? env[`APPRHYTHM_${suffix}`]
}

function present(file: string): boolean {
  try {lstatSync(file); return true} catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw new McpError('naming-conflict', `Cannot inspect ${file}. Check permissions before retrying.`)
  }
}

/** Select the sole existing name, or the canonical name for new projects. Never merge. */
function select(root: string, canonical: string, legacy: string): string {
  const current = path.join(root, canonical), previous = path.join(root, legacy)
  const hasCurrent = present(current), hasPrevious = present(previous)
  if (hasCurrent && hasPrevious) throw new McpError('naming-conflict', `Both ${canonical} and ${legacy} exist. Back up both, choose the intended project data, and move the other outside this directory before retrying. Nothing was migrated.`)
  return hasPrevious ? previous : current
}

export function configFilePath(root: string = process.cwd()): string {
  return select(root, 'ritmo.yaml', 'apprhythm.yaml')
}

export function stateDirectory(root: string = process.cwd()): string {
  const selected = select(root, '.ritmo', '.apprhythm')
  if (present(selected)) {
    const stat = lstatSync(selected)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new McpError('naming-conflict', `State path ${selected} must be a real directory, not a symlink. Move it aside before retrying.`)
  }
  return selected
}

export function manifestFilePath(root: string = process.cwd()): string {
  return select(root, 'ritmo.manifest.json', 'apprhythm.manifest.json')
}
