/**
 * Filesystem walking for the scanner.
 *
 * The walk is bounded on three axes (file count, file size, directory depth)
 * because `openhog init` runs in repos nobody has vetted, including monorepos
 * with a vendored toolchain in them. A scan that takes four minutes reads as a
 * hang, and the marginal signal from the 20,000th file is zero.
 */

import { readdirSync, readFileSync, statSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, relative, dirname, sep } from 'node:path'

export const DEFAULT_IGNORE = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.output',
  '.vercel',
  '.netlify',
  'coverage',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  'target',
  'Pods',
  'DerivedData',
  '.gradle',
  '.idea',
  '.vscode',
  'tmp',
  '.cache',
  '.turbo',
  'storybook-static',
  '.terraform',
]

/** Extensions worth opening. Anything else is counted but never read. */
export const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.vue',
  '.svelte',
  '.astro',
  '.py',
  '.rb',
  '.go',
  '.swift',
  '.kt',
  '.java',
  '.dart',
  '.php',
  '.rs',
])

const MAX_FILES = 20_000
const MAX_FILE_BYTES = 512 * 1024
const MAX_DEPTH = 12

export interface WalkOptions {
  ignore?: string[]
  maxFiles?: number
  /** Only return files whose extension is in this set. */
  extensions?: Set<string>
}

/** Every file under `root`, depth-first, bounded. Paths are absolute. */
export function walk(root: string, options: WalkOptions = {}): string[] {
  const ignore = new Set([...DEFAULT_IGNORE, ...(options.ignore ?? [])])
  const maxFiles = options.maxFiles ?? MAX_FILES
  const results: string[] = []

  const visit = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || results.length >= maxFiles) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) return
      // A leading dot is not disqualifying on its own: .github and .claude both
      // carry signal. Only the explicit ignore list and dot-dirs we know are
      // build output are skipped.
      if (ignore.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        visit(full, depth + 1)
      } else if (entry.isFile()) {
        if (options.extensions) {
          const dot = entry.name.lastIndexOf('.')
          if (dot < 0 || !options.extensions.has(entry.name.slice(dot))) continue
        }
        results.push(full)
      }
    }
  }

  visit(root, 0)
  return results
}

/** Read a file, or null when it is missing, unreadable, or implausibly large. */
export function readIfSmall(path: string, maxBytes = MAX_FILE_BYTES): string | null {
  try {
    const stats = statSync(path)
    if (!stats.isFile() || stats.size > maxBytes) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

export function readJson<T>(path: string): T | null {
  const raw = readIfSmall(path)
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export function writeJson(path: string, value: unknown): void {
  ensureDir(dirname(path))
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export function writeText(path: string, value: string): void {
  ensureDir(dirname(path))
  writeFileSync(path, value, 'utf8')
}

export function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true })
}

export function exists(path: string): boolean {
  return existsSync(path)
}

/** Repo-relative, POSIX separators, so generated docs read the same everywhere. */
export function relPath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}

/** Walk up from `start` looking for a directory that holds `marker`. */
export function findUp(start: string, marker: string, limit = 8): string | null {
  let dir = start
  for (let i = 0; i < limit; i += 1) {
    if (existsSync(join(dir, marker))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}
