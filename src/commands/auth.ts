/**
 * `openhog auth` - connect, re-connect, check, or forget a personal API key.
 *
 * `--instructions` prints the same walk as JSON, for a coding agent with
 * browser control that can do the clicking on the user's behalf. The key itself
 * never passes through the agent's context: the agent navigates and points, the
 * human copies, and OpenHog reads it from stdin or the environment.
 */

import type { Argv } from '../cli.js'
import {
  authInstructions,
  credentialsPath,
  forgetKey,
  keyPageUrl,
  resolvePersonalKey,
  REQUIRED_SCOPES,
} from '../posthog/auth.js'
import { PostHogClient, hostsForRegion } from '../posthog/client.js'
import { loadConfig } from '../config.js'
import { color, log } from '../util/log.js'
import { regionFrom, rootFrom } from './shared.js'

export async function runAuth(argv: Argv): Promise<number> {
  const root = rootFrom(argv)
  const config = loadConfig(root)
  const { region, host } = regionFrom(argv, config)
  const hosts = hostsForRegion(region, host)

  if (argv.flags.instructions) {
    process.stdout.write(`${JSON.stringify(authInstructions(region, host), null, 2)}\n`)
    return 0
  }

  if (argv.flags.forget || argv.flags.logout) {
    forgetKey(hosts.host)
    log.ok(`Forgot the key for ${hosts.host}.`)
    log.info(credentialsPath())
    return 0
  }

  if (argv.flags.check) {
    try {
      const { key, source } = await resolvePersonalKey({ region, customHost: host, envOnly: true })
      const client = new PostHogClient({ personalApiKey: key, hosts })
      const projects = await client.listProjects()
      log.ok(`Key from ${source} works. ${projects.length} project(s) visible:`)
      for (const project of projects) log.info(`${project.id}  ${project.name}`)
      return 0
    } catch (error) {
      log.fail(error instanceof Error ? error.message : String(error))
      log.info(`Create one at ${keyPageUrl(hosts)} with scopes: ${REQUIRED_SCOPES.join(', ')}`)
      return 1
    }
  }

  const { source } = await resolvePersonalKey({
    region,
    customHost: host,
    reset: argv.flags.reset === true,
  })
  log.ok(`Connected to ${color.bold(hosts.host)} (key from ${source}).`)
  return 0
}
