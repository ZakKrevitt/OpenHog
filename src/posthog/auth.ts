/**
 * Getting a personal API key, which is the one step nobody can automate away.
 *
 * The key is minted in PostHog's UI and never leaves the user's hands, so the
 * job here is to make the walk as short as possible: name the exact page, name
 * the exact scopes, open the browser, take the paste without echoing it, prove
 * it works before saving it, and store it outside the repo so it cannot be
 * committed by accident.
 *
 * There is a second audience. When OpenHog runs inside a coding agent that can
 * drive a browser, `authInstructions()` returns the same walk as structured
 * steps the agent can execute on the user's behalf.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import type { PostHogRegion } from '../types.js'
import { color, log } from '../util/log.js'
import { confirm, isNonInteractive, text } from '../util/prompt.js'
import { PostHogClient, PostHogError, hostsForRegion, type RegionHosts } from './client.js'

/** Everything OpenHog does, and nothing else. */
export const REQUIRED_SCOPES = [
  'project:read',
  'insight:write',
  'dashboard:write',
  'query:read',
] as const

export const OPTIONAL_SCOPES = [
  'event_definition:read',
  'property_definition:read',
  'annotation:write',
] as const

const CREDENTIALS_DIR = join(homedir(), '.openhog')
const CREDENTIALS_FILE = join(CREDENTIALS_DIR, 'credentials.json')

interface CredentialStore {
  version: 1
  /** Keyed by API host so US, EU and self-hosted keys coexist. */
  keys: Record<string, string>
}

function readStore(): CredentialStore {
  if (!existsSync(CREDENTIALS_FILE)) return { version: 1, keys: {} }
  try {
    const parsed = JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf8')) as CredentialStore
    return parsed.keys ? parsed : { version: 1, keys: {} }
  } catch {
    return { version: 1, keys: {} }
  }
}

function writeStore(store: CredentialStore): void {
  if (!existsSync(CREDENTIALS_DIR)) mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(CREDENTIALS_FILE, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
  try {
    chmodSync(CREDENTIALS_FILE, 0o600)
  } catch {
    // Windows and some mounted filesystems reject chmod. The file is still
    // outside the repo, which is the property that actually matters.
  }
}

export function storedKey(host: string): string | undefined {
  return readStore().keys[host]
}

export function saveKey(host: string, key: string): void {
  const store = readStore()
  store.keys[host] = key
  writeStore(store)
}

export function forgetKey(host: string): void {
  const store = readStore()
  delete store.keys[host]
  writeStore(store)
}

export function credentialsPath(): string {
  return CREDENTIALS_FILE
}

/** The page that mints a personal API key, for a given region. */
export function keyPageUrl(hosts: RegionHosts): string {
  return `${hosts.host}/settings/user-api-keys`
}

function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  try {
    const child = spawn(command, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' })
    child.unref()
  } catch {
    // Headless box or no handler registered. The URL is printed either way.
  }
}

export function looksLikePersonalKey(key: string): boolean {
  return /^phx_[A-Za-z0-9_-]{20,}$/.test(key.trim())
}

export function looksLikeProjectKey(key: string): boolean {
  return /^phc_[A-Za-z0-9_-]{20,}$/.test(key.trim())
}

/**
 * The structured version of the walk, for an agent with browser control. Kept
 * next to the interactive flow so the two can never drift.
 */
export function authInstructions(region: PostHogRegion, customHost?: string) {
  const hosts = hostsForRegion(region, customHost)
  return {
    goal: 'Obtain a PostHog personal API key so OpenHog can create dashboards.',
    url: keyPageUrl(hosts),
    steps: [
      `Open ${keyPageUrl(hosts)} (the user must already be signed in to PostHog).`,
      'Click "Create personal API key".',
      'Set the label to "OpenHog".',
      'Under "Organization & project access", scope the key to the project you want dashboards in.',
      `Under "Scopes", enable exactly: ${REQUIRED_SCOPES.join(', ')}.`,
      `Optionally also enable: ${OPTIONAL_SCOPES.join(', ')} (richer drift checks and annotations).`,
      'Click "Create key" and copy the value shown once. It starts with phx_.',
      'Pass it to OpenHog as the POSTHOG_PERSONAL_API_KEY environment variable, or paste it when `openhog auth` asks.',
    ],
    warning:
      'This key can read and write the whole project it is scoped to. Never paste it into a file that is committed, and never post it in a chat log. OpenHog stores it in ~/.openhog/credentials.json with 0600 permissions.',
    verifyCommand: 'openhog auth --check',
  }
}

export interface ResolveKeyOptions {
  region: PostHogRegion
  customHost?: string
  /** Skip the store and the prompt; fail if the env var is absent. */
  envOnly?: boolean
  /** Force the interactive walk even when a key is already stored. */
  reset?: boolean
}

export interface ResolvedKey {
  key: string
  hosts: RegionHosts
  source: 'env' | 'stored' | 'prompt'
}

/**
 * Env var, then the credential store, then the interactive walk. The order is
 * deliberate: CI passes an env var, a returning user has a stored key, and only
 * a first run should ever see a prompt.
 */
export async function resolvePersonalKey(options: ResolveKeyOptions): Promise<ResolvedKey> {
  const hosts = hostsForRegion(options.region, options.customHost)

  const fromEnv = process.env.POSTHOG_PERSONAL_API_KEY?.trim()
  if (fromEnv && !options.reset) return { key: fromEnv, hosts, source: 'env' }

  if (!options.reset) {
    const saved = storedKey(hosts.host)
    if (saved) return { key: saved, hosts, source: 'stored' }
  }

  if (options.envOnly) {
    throw new PostHogError('No POSTHOG_PERSONAL_API_KEY in the environment.', {
      hint: 'Run `openhog auth` once interactively, or set the variable in CI.',
    })
  }

  if (isNonInteractive()) {
    throw new PostHogError('OpenHog needs a PostHog personal API key and there is no TTY to ask on.', {
      hint: `Set POSTHOG_PERSONAL_API_KEY, or run \`openhog auth\` in a terminal. Create the key at ${keyPageUrl(hosts)} with scopes: ${REQUIRED_SCOPES.join(', ')}.`,
    })
  }

  const key = await interactiveKeyWalk(hosts)
  saveKey(hosts.host, key)
  log.ok(`Key saved to ${color.grey(CREDENTIALS_FILE)} (readable only by you).`)
  return { key, hosts, source: 'prompt' }
}

async function interactiveKeyWalk(hosts: RegionHosts): Promise<string> {
  const url = keyPageUrl(hosts)

  log.title('Connect your PostHog project')
  log.plain(
    `OpenHog needs a ${color.bold('personal API key')} to create dashboards in your own project.
The key is created by you, in PostHog, and stays on this machine.`,
  )
  log.plain()
  log.plain(`  ${color.bold('1.')} Open ${color.cyan(url)}`)
  log.plain(`  ${color.bold('2.')} Click ${color.bold('Create personal API key')}, label it ${color.bold('OpenHog')}`)
  log.plain(`  ${color.bold('3.')} Scope it to the project you want dashboards in`)
  log.plain(`  ${color.bold('4.')} Tick these scopes:`)
  for (const scope of REQUIRED_SCOPES) log.plain(`       ${color.green('✓')} ${color.bold(scope)}`)
  log.plain(`     ${color.grey('optional, for drift checks and deploy annotations:')}`)
  for (const scope of OPTIONAL_SCOPES) log.plain(`       ${color.grey('·')} ${color.grey(scope)}`)
  log.plain(`  ${color.bold('5.')} Copy the key. It starts with ${color.bold('phx_')} and is shown once.`)
  log.plain()

  if (await confirm('Open that page in your browser now?', true)) {
    openBrowser(url)
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const key = await text('Paste the key (input is hidden):', '', { mask: true })
    if (!key) {
      log.warn('Nothing pasted.')
      continue
    }
    if (looksLikeProjectKey(key)) {
      log.fail('That is a project key (phc_...), which can only send events.')
      log.info('OpenHog needs a personal API key (phx_...) from Settings → Personal API keys.')
      continue
    }
    if (!looksLikePersonalKey(key)) {
      log.warn('That does not look like a personal API key (they start with phx_). Trying it anyway.')
    }

    const client = new PostHogClient({ personalApiKey: key, hosts })
    try {
      const projects = await client.listProjects()
      log.ok(
        `Key works. It can see ${projects.length} project${projects.length === 1 ? '' : 's'}.`,
      )
      return key
    } catch (error) {
      const message = error instanceof PostHogError ? error.message : String(error)
      log.fail(message)
      if (error instanceof PostHogError && error.hint) log.info(error.hint)
    }
  }

  throw new PostHogError('Could not verify a personal API key after three attempts.', {
    hint: `Create one at ${url} with scopes: ${REQUIRED_SCOPES.join(', ')}.`,
  })
}
