/**
 * Reading and writing the two files OpenHog owns in a user's repo.
 *
 * Both are plain JSON and both are meant to be edited by hand and reviewed in
 * pull requests. That is the point: analytics changes should be diffable, and
 * "why did this number change" should be answerable from git history.
 */

import { join } from 'node:path'
import type { OpenHogConfig, PostHogRegion, ProductKind, TrackingPlan } from './types.js'
import { exists, readJson, writeJson } from './util/fs.js'
import { hostsForRegion } from './posthog/client.js'

export const CONFIG_FILE = 'openhog.config.json'
export const DEFAULT_PLAN_PATH = 'openhog/tracking-plan.json'
export const DEFAULT_WALKTHROUGH_PATH = 'ANALYTICS.md'

export function configPath(root: string): string {
  return join(root, CONFIG_FILE)
}

export function loadConfig(root: string): OpenHogConfig | null {
  return readJson<OpenHogConfig>(configPath(root))
}

export function saveConfig(root: string, config: OpenHogConfig): void {
  writeJson(configPath(root), config)
}

export function hasConfig(root: string): boolean {
  return exists(configPath(root))
}

export function planPath(root: string, config: OpenHogConfig | null): string {
  return join(root, config?.paths?.plan ?? DEFAULT_PLAN_PATH)
}

export function loadPlan(root: string, config: OpenHogConfig | null): TrackingPlan | null {
  return readJson<TrackingPlan>(planPath(root, config))
}

export function savePlan(root: string, config: OpenHogConfig | null, plan: TrackingPlan): string {
  const path = planPath(root, config)
  writeJson(path, plan)
  return path
}

export interface BuildConfigOptions {
  region: PostHogRegion
  customHost?: string
  projectId?: number
  publicKeyEnv: string
  kind: ProductKind
  packs: string[]
  analyticsModulePath?: string
  walkthroughPath?: string
}

export function buildConfig(options: BuildConfigOptions): OpenHogConfig {
  const hosts = hostsForRegion(options.region, options.customHost)
  return {
    version: 1,
    posthog: {
      region: options.region,
      host: hosts.host,
      ingestHost: hosts.ingestHost,
      assetHost: hosts.assetHost,
      projectId: options.projectId,
      publicKeyEnv: options.publicKeyEnv,
    },
    product: {
      kind: options.kind,
      packs: options.packs,
    },
    paths: {
      plan: DEFAULT_PLAN_PATH,
      analyticsModule: options.analyticsModulePath,
      walkthrough: options.walkthroughPath ?? DEFAULT_WALKTHROUGH_PATH,
    },
  }
}

/**
 * The env var the browser SDK reads. Frameworks disagree about which prefix is
 * exposed to client code, and picking the wrong one produces a key that is
 * `undefined` at runtime with no error anywhere — which is indistinguishable
 * from "analytics is broken".
 */
export function publicKeyEnvFor(frameworks: string[]): string {
  if (frameworks.includes('nextjs')) return 'NEXT_PUBLIC_POSTHOG_KEY'
  if (frameworks.includes('nuxt')) return 'NUXT_PUBLIC_POSTHOG_KEY'
  if (frameworks.includes('astro')) return 'PUBLIC_POSTHOG_KEY'
  if (frameworks.includes('sveltekit') || frameworks.includes('svelte')) return 'PUBLIC_POSTHOG_KEY'
  if (frameworks.includes('expo') || frameworks.includes('react-native')) return 'EXPO_PUBLIC_POSTHOG_KEY'
  if (frameworks.includes('angular')) return 'NG_APP_POSTHOG_KEY'
  return 'VITE_PUBLIC_POSTHOG_KEY'
}

export function envStyleFor(frameworks: string[]): 'vite' | 'next' | 'process' {
  if (frameworks.includes('nextjs') || frameworks.includes('remix')) return 'next'
  if (
    frameworks.includes('react') ||
    frameworks.includes('vue') ||
    frameworks.includes('svelte') ||
    frameworks.includes('sveltekit') ||
    frameworks.includes('solid') ||
    frameworks.includes('astro')
  ) {
    return 'vite'
  }
  return 'process'
}

/** Where the generated analytics module should live for a given layout. */
export function analyticsModulePathFor(root: string, entryFile: string | undefined): string {
  if (!entryFile) return 'openhog/analytics.ts'
  const segments = entryFile.split('/')
  // Drop the filename, then place the module beside the app's own source root
  // rather than next to the entry point, which is often a layout deep in a tree.
  const srcIndex = segments.indexOf('src')
  if (srcIndex >= 0) return [...segments.slice(0, srcIndex + 1), 'analytics.ts'].join('/')
  const appIndex = segments.indexOf('app')
  if (appIndex > 0) return [...segments.slice(0, appIndex), 'lib', 'analytics.ts'].join('/')
  return 'openhog/analytics.ts'
}
