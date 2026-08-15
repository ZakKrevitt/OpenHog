/**
 * `openhog demo` - make an empty project look like a real one.
 *
 * Two audiences: someone evaluating OpenHog who has no traffic yet, and a team
 * that has just instrumented and wants to see the charts work before real data
 * arrives. Both need to see the shape of a working dashboard.
 */

import type { Argv } from '../cli.js'
import { generateDemoEvents, seedDemoData } from '../demo/seed.js'
import { loadPlan } from '../config.js'
import { color, log, spinner } from '../util/log.js'
import { confirm } from '../util/prompt.js'
import { connect, requireConfig, rootFrom } from './shared.js'
import { PostHogError } from '../posthog/client.js'

export async function runDemo(argv: Argv): Promise<number> {
  const root = rootFrom(argv)
  const config = requireConfig(root)
  const plan = loadPlan(root, config)

  if (!plan) {
    log.fail('No tracking plan found. Run `npx openhog init` first.')
    return 1
  }

  const people = Number.parseInt(String(argv.flags.people ?? '600'), 10)
  const days = Number.parseInt(String(argv.flags.days ?? '60'), 10)

  const preview = generateDemoEvents({ plan, people, days })
  log.info(`${preview.length} events across ${people} simulated people and ${days} days.`)

  if (argv.flags['dry-run']) {
    const byEvent = new Map<string, number>()
    for (const event of preview) byEvent.set(event.event, (byEvent.get(event.event) ?? 0) + 1)
    for (const [name, count] of [...byEvent.entries()].sort((a, b) => b[1] - a[1])) {
      log.plain(`  ${color.bold(String(count).padStart(6))}  ${name}`)
    }
    return 0
  }

  log.warn('This writes real events into your PostHog project.')
  log.info('They are tagged is_demo_data:true with openhog_demo_* person ids, but PostHog')
  log.info('has no bulk delete, so the cleanest place to do this is a scratch project.')
  if (!(await confirm('Seed the data?', false))) return 0

  const connection = await connect(argv)
  if (!connection.publicKey) {
    throw new PostHogError('Could not read the project key needed to send events.', {
      hint: 'The personal API key needs the project:read scope.',
    })
  }

  const seedSpinner = spinner('Seeding…')
  const result = await seedDemoData(connection.client, connection.publicKey, {
    plan,
    people,
    days,
    onProgress: (sent, total) => seedSpinner.update(`${sent}/${total} events`),
  })
  seedSpinner.stop()

  log.ok(`Sent ${result.sent} events in ${result.batches} batches.`)
  log.info('Ingestion takes a minute or two. Refresh the dashboards after that.')
  log.info(`${connection.client.hosts.host}/project/${connection.projectId}/dashboard`)
  return 0
}
