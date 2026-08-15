/**
 * Framework, package manager and surface detection.
 *
 * Detection is additive: a repo with `web/` and `ios/` reports both, because a
 * monorepo is the normal case and picking one surface silently would generate a
 * tracking plan that ignores half the product.
 */

import { join, basename } from 'node:path'
import type { Framework } from '../types.js'
import { exists, readJson, walk, readIfSmall } from '../util/fs.js'

interface PackageJson {
  name?: string
  description?: string
  homepage?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  scripts?: Record<string, string>
}

/** Every package.json in the repo, so monorepo workspaces are seen. */
export function findPackageJsons(root: string, files: string[]): { path: string; json: PackageJson }[] {
  const found: { path: string; json: PackageJson }[] = []
  const rootPkg = readJson<PackageJson>(join(root, 'package.json'))
  if (rootPkg) found.push({ path: join(root, 'package.json'), json: rootPkg })
  for (const file of files) {
    if (basename(file) !== 'package.json') continue
    if (file === join(root, 'package.json')) continue
    const json = readJson<PackageJson>(file)
    if (json) found.push({ path: file, json })
  }
  return found
}

const DEPENDENCY_FRAMEWORKS: [string, Framework][] = [
  ['next', 'nextjs'],
  ['@remix-run/react', 'remix'],
  ['@sveltejs/kit', 'sveltekit'],
  ['nuxt', 'nuxt'],
  ['astro', 'astro'],
  ['expo', 'expo'],
  ['react-native', 'react-native'],
  ['@angular/core', 'angular'],
  ['solid-js', 'solid'],
  ['svelte', 'svelte'],
  ['vue', 'vue'],
  ['react', 'react'],
  ['express', 'express'],
  ['fastify', 'express'],
  ['hono', 'express'],
]

export function detectFrameworks(root: string, files: string[]): Framework[] {
  const found = new Set<Framework>()
  const packages = findPackageJsons(root, files)

  for (const { json } of packages) {
    const deps = { ...json.dependencies, ...json.devDependencies }
    for (const [dep, framework] of DEPENDENCY_FRAMEWORKS) {
      if (deps[dep]) found.add(framework)
    }
  }

  // A React app that is also a Next app is just a Next app; the more specific
  // framework decides where routes live and how init gets wired.
  if (found.has('nextjs') || found.has('remix') || found.has('astro')) found.delete('react')
  if (found.has('sveltekit')) found.delete('svelte')
  if (found.has('nuxt')) found.delete('vue')
  if (found.has('expo')) found.delete('react-native')

  // Non-JS surfaces, detected by manifest rather than by extension so a single
  // stray .py in a JS repo does not invent a Django backend.
  const hasFile = (name: string) => files.some((file) => basename(file) === name)
  const requirements =
    readIfSmall(join(root, 'requirements.txt')) ??
    readIfSmall(join(root, 'pyproject.toml')) ??
    ''
  if (/\bdjango\b/i.test(requirements) || hasFile('manage.py')) found.add('django')
  if (/\bfastapi\b/i.test(requirements)) found.add('fastapi')
  if (/\bflask\b/i.test(requirements)) found.add('flask')
  if (hasFile('Gemfile') && /\brails\b/i.test(readIfSmall(join(root, 'Gemfile')) ?? '')) {
    found.add('rails')
  }
  if (files.some((file) => file.endsWith('.xcodeproj/project.pbxproj') || file.endsWith('Package.swift'))) {
    found.add('swift-ios')
  }
  if (files.some((file) => file.endsWith('.swift')) && !found.has('swift-ios')) {
    // An .xcodeproj is a directory, so the walk yields its contents rather than
    // the bundle itself in some layouts. Swift sources are enough of a signal.
    found.add('swift-ios')
  }
  if (hasFile('build.gradle') || hasFile('build.gradle.kts')) found.add('kotlin-android')
  if (hasFile('pubspec.yaml')) found.add('flutter')

  if (found.size === 0 && packages.length > 0) found.add('node')
  if (found.size === 0) found.add('unknown')

  return [...found]
}

export function detectPackageManager(root: string): 'npm' | 'pnpm' | 'yarn' | 'bun' | 'none' {
  if (exists(join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (exists(join(root, 'bun.lockb')) || exists(join(root, 'bun.lock'))) return 'bun'
  if (exists(join(root, 'yarn.lock'))) return 'yarn'
  if (exists(join(root, 'package-lock.json'))) return 'npm'
  if (exists(join(root, 'package.json'))) return 'npm'
  return 'none'
}

const WEB_FRAMEWORKS = new Set<Framework>([
  'nextjs',
  'react',
  'vue',
  'svelte',
  'sveltekit',
  'nuxt',
  'astro',
  'remix',
  'solid',
  'angular',
])
const BACKEND_FRAMEWORKS = new Set<Framework>(['django', 'fastapi', 'flask', 'rails', 'express', 'node'])

export function detectSurfaces(frameworks: Framework[]): string[] {
  const surfaces = new Set<string>()
  for (const framework of frameworks) {
    if (WEB_FRAMEWORKS.has(framework)) surfaces.add('web')
    else if (BACKEND_FRAMEWORKS.has(framework)) surfaces.add('backend')
    else if (framework === 'swift-ios') surfaces.add('ios')
    else if (framework === 'kotlin-android') surfaces.add('android')
    else if (framework === 'react-native' || framework === 'expo' || framework === 'flutter') {
      surfaces.add('mobile')
    }
  }
  if (surfaces.size === 0) surfaces.add('web')
  return [...surfaces]
}

/**
 * The file `initAnalytics()` should be called from. Ordered by how unambiguous
 * the choice is: a Next root layout is exactly one file, whereas `src/main.tsx`
 * is a convention that a given repo may not follow.
 */
const ENTRY_CANDIDATES = [
  'app/layout.tsx',
  'app/layout.jsx',
  'src/app/layout.tsx',
  'pages/_app.tsx',
  'pages/_app.jsx',
  'src/pages/_app.tsx',
  'src/routes/+layout.svelte',
  'app/root.tsx',
  'src/main.tsx',
  'src/main.ts',
  'src/main.jsx',
  'src/index.tsx',
  'src/index.ts',
  'src/App.tsx',
  'app/_layout.tsx',
  'App.tsx',
  'src/app/app.component.ts',
]

export function detectEntryFile(root: string, files: string[]): string | undefined {
  for (const candidate of ENTRY_CANDIDATES) {
    const full = join(root, candidate)
    if (files.includes(full)) return full
  }
  // Fall back to any file matching the last path segment anywhere in the tree,
  // which is what catches `web/src/main.tsx` in a monorepo.
  for (const candidate of ENTRY_CANDIDATES) {
    const suffix = `/${candidate}`
    const match = files.find((file) => file.endsWith(suffix))
    if (match) return match
  }
  return undefined
}

/** Files that could carry a CSP the doctor needs to inspect. */
export function detectCspFiles(root: string, files: string[]): string[] {
  const names = new Set([
    'vercel.json',
    'next.config.js',
    'next.config.mjs',
    'next.config.ts',
    'netlify.toml',
    '_headers',
    'nginx.conf',
    'middleware.ts',
    'middleware.js',
    'svelte.config.js',
    'nuxt.config.ts',
  ])
  const candidates = files.filter((file) => names.has(basename(file)))
  return candidates.filter((file) => {
    const content = readIfSmall(file)
    return content ? /content-security-policy|contentSecurityPolicy|csp/i.test(content) : false
  })
}

export function listSourceFiles(root: string, ignore: string[], extensions: Set<string>): string[] {
  return walk(root, { ignore, extensions })
}
