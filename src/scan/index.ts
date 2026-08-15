/**
 * The scan: one pass over a repository that answers "what is this, what does it
 * do, and what does it already measure".
 *
 * Everything downstream reads a `ScanResult` and nothing else, so the scan is
 * the only part of OpenHog that touches an unknown filesystem. That boundary is
 * what lets `openhog init --dry-run` and the test suite work against fixtures.
 */

import { join } from 'node:path'
import type { ScanResult } from '../types.js'
import { SOURCE_EXTENSIONS, readIfSmall, relPath, walk } from '../util/fs.js'
import {
  detectCspFiles,
  detectEntryFile,
  detectFrameworks,
  detectPackageManager,
  detectSurfaces,
  findPackageJsons,
} from './detect.js'
import { buildProductProfile, guessProductKind } from './product.js'
import { detectRoutes, sensitiveRoutes } from './routes.js'
import { detectAnalyticsLibraries, detectEventCalls } from './events.js'
import { detectSignals } from './signals.js'

export interface ScanOptions {
  ignore?: string[]
  maxFiles?: number
}

export function scan(root: string, options: ScanOptions = {}): ScanResult {
  // Two walks: one unfiltered (so manifests, configs and READMEs are seen), and
  // the source subset the expensive content passes actually read.
  const allFiles = walk(root, { ignore: options.ignore, maxFiles: options.maxFiles ?? 20_000 })
  const sourceFiles = allFiles.filter((file) => {
    const dot = file.lastIndexOf('.')
    return dot >= 0 && SOURCE_EXTENSIONS.has(file.slice(dot))
  })

  const frameworks = detectFrameworks(root, allFiles)
  const surfaces = detectSurfaces(frameworks)
  const packageManager = detectPackageManager(root)
  const product = buildProductProfile(root, allFiles)
  const routes = detectRoutes(root, allFiles, frameworks)
  const existingEvents = detectEventCalls(root, sourceFiles)
  const existingAnalytics = detectAnalyticsLibraries(sourceFiles.slice(0, 2500))

  const dependencyBlob = findPackageJsons(root, allFiles)
    .map(({ json }) => JSON.stringify({ ...json.dependencies, ...json.devDependencies }))
    .concat(readIfSmall(join(root, 'requirements.txt')) ?? '')
    .concat(readIfSmall(join(root, 'pyproject.toml')) ?? '')
    .concat(readIfSmall(join(root, 'Podfile')) ?? '')
    .join('\n')

  const signals = detectSignals(sourceFiles, dependencyBlob)
  const entryFile = detectEntryFile(root, allFiles)
  const cspFiles = detectCspFiles(root, allFiles).map((file) => relPath(root, file))

  return {
    root,
    frameworks,
    surfaces,
    packageManager,
    product,
    routes,
    existingEvents,
    signals,
    existingAnalytics,
    cspFiles,
    entryFile: entryFile ? relPath(root, entryFile) : undefined,
    filesScanned: allFiles.length,
  }
}

/** The text an LLM (or the heuristic classifier) reasons over. */
export function productContext(result: ScanResult): string {
  const lines = [
    `Name: ${result.product.name}`,
    `Description: ${result.product.description}`,
    result.product.url ? `URL: ${result.product.url}` : '',
    `Frameworks: ${result.frameworks.join(', ')}`,
    `Surfaces: ${result.surfaces.join(', ')}`,
    '',
    'Evidence gathered from the repository:',
    ...result.product.evidence.map((line) => `- ${line}`),
    '',
    `Routes (${result.routes.length}):`,
    ...result.routes.slice(0, 60).map((route) => `- ${route.path}${route.role ? ` [${route.role}]` : ''}`),
    '',
    `Feature signals: ${Object.entries(result.signals)
      .filter(([, value]) => value)
      .map(([key]) => key.replace(/^has/, '').toLowerCase())
      .join(', ') || 'none detected'}`,
    '',
    `Events already emitted (${result.existingEvents.length}):`,
    ...result.existingEvents.slice(0, 120).map((event) => `- ${event.name} (${event.file}:${event.line})`),
  ]
  return lines.filter(Boolean).join('\n')
}

export { guessProductKind, sensitiveRoutes }
export * from './detect.js'
export * from './product.js'
export * from './routes.js'
export * from './events.js'
export * from './signals.js'
