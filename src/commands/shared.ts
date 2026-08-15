/**
 * Things every command needs: where the repo is, which region, which project,
 * and a connected client.
 */

import { resolve } from 'node:path'
import type { Argv } from '../cli.js'
import type { OpenHogConfig, PostHogRegion } from '../types.js'
import { PostHogClient, PostHogError, hostsForRegion } from '../posthog/client.js'
import { resolvePersonalKey } from '../posthog/auth.js'
import { loadConfig } from '../config.js'
import { color, log } from '../util/log.js'
import { select } from '../util/prompt.js'

export function rootFrom(argv: Argv): string {
  const cwd = typeof argv.flags.cwd === 'string' ? argv.flags.cwd : process.cwd()
  return resolve(cwd)
}

export function regionFrom(argv: Argv, config: OpenHogConfig | null): { region: PostHogRegion; host?: string } {
  if (typeof argv.flags.host === 'string') return { region: 'custom', host: argv.flags.host }
  if (typeof argv.flags.region === 'string') {
    const value = argv.flags.region.toLowerCase()
    if (value === 'us' || value === 'eu') return { region: value }
    return { region: 'custom', host: argv.flags.region }
  }
  if (config) return { region: config.posthog.region, host: config.posthog.host }
  return { region: 'us' }
}

export interface Connection {
  client: PostHogClient
  projectId: number
  publicKey?: string
  config: OpenHogConfig | null
  root: string
}

/**
 * Connect to PostHog and settle on a project. The project key (`phc_`) is read
 * off the project itself rather than asked for, because the personal key can
 * already see it and one fewer copy-paste is one fewer place to get it wrong.
 */
export async function connect(argv: Argv, options: { requireProject?: boolean } = {}): Promise<Connection> {
  const root = rootFrom(argv)
  const config = loadConfig(root)
  const { region, host } = regionFrom(argv, config)

  const { key, hosts } = await resolvePersonalKey({ region, customHost: host })
  const client = new PostHogClient({ personalApiKey: key, hosts })

  let projectId =
    typeof argv.flags.project === 'string'
      ? Number.parseInt(argv.flags.project, 10)
      : config?.posthog.projectId

  if (!projectId) {
    const projects = await client.listProjects()
    if (projects.length === 0) {
      throw new PostHogError('That key cannot see any PostHog projects.', {
        hint: 'Check the key is scoped to an organisation and has the project:read scope.',
      })
    }
    if (projects.length === 1) {
      projectId = projects[0]!.id
      log.info(`Using project ${color.bold(projects[0]!.name)} (${projectId}).`)
    } else {
      const chosen = await select(
        'Which PostHog project?',
        projects.map((project) => ({
          value: String(project.id),
          label: project.name,
          hint: `id ${project.id}`,
        })),
        String(projects[0]!.id),
      )
      projectId = Number.parseInt(chosen, 10)
    }
  }

  if (!projectId && options.requireProject !== false) {
    throw new PostHogError('No PostHog project selected.', { hint: 'Pass --project <id>.' })
  }

  let publicKey: string | undefined
  try {
    const project = await client.getProject(projectId!)
    publicKey = project.api_token
  } catch {
    // project:read may be absent. Everything except ingest still works.
  }

  return { client, projectId: projectId!, publicKey, config, root }
}

export function requireConfig(root: string): OpenHogConfig {
  const config = loadConfig(root)
  if (!config) {
    throw new PostHogError(`No ${color.bold('openhog.config.json')} in ${root}.`, {
      hint: 'Run `npx openhog init` first.',
    })
  }
  return config
}

export { hostsForRegion }
