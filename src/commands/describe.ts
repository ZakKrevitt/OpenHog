/**
 * `openhog describe` - write what your events mean into PostHog itself.
 *
 * Everything else OpenHog produces lives in a terminal or an HTML file. This is
 * the one command that makes PostHog's own website better: a description on an
 * event definition shows up in the event list, the insight builder and every
 * picker anybody opens, for everyone in the organisation, indefinitely. The
 * person it helps most is the one who joins in eight months and has never heard
 * of this tool.
 *
 * It is also the only thing OpenHog does that changes what other people see, so
 * it is built to be the most cautious command in the package:
 *
 *   - **It previews by default.** Writing requires `--write`, said out loud.
 *   - **It never overwrites a human's description** unless asked, because
 *     silently replacing somebody's documentation is how a tool gets banned
 *     from an organisation.
 *   - **The first write verifies itself.** One definition is patched and read
 *     back before any others are attempted, so a deployment that rejects the
 *     call costs one event rather than four hundred.
 *   - **It writes a rollback file** with every previous value before touching
 *     anything, so the change is reversible.
 *   - **It is idempotent.** Running it twice changes nothing the second time.
 */

import { join } from 'node:path'
import type { Argv } from '../cli.js'
import { PostHogError } from '../posthog/client.js'
import { discoverProject } from '../metrics/discover.js'
import { buildDescriptions, toApply, type ProposedDescription } from '../describe/descriptions.js'
import { loadConfig, loadPlan } from '../config.js'
import { writeJson } from '../util/fs.js'
import { color, log, spinner } from '../util/log.js'
import { confirm, isNonInteractive } from '../util/prompt.js'
import { connect, rootFrom } from './shared.js'

const SOURCE_LABEL = {
  plan: 'from your tracking plan',
  role: 'from the role it plays',
  behaviour: 'from how it behaves',
} as const

export async function runDescribe(argv: Argv): Promise<number> {
  const root = rootFrom(argv)
  const config = loadConfig(root)
  const plan = loadPlan(root, config)
  const connection = await connect(argv)

  const progress = spinner('Reading your events…')
  const [discovery, definitions] = await Promise.all([
    discoverProject(connection.client, connection.projectId),
    connection.client.listEventDefinitions(connection.projectId),
  ])
  progress.stop()

  const byName = new Map(definitions.map((definition) => [definition.name, definition]))
  const existing = new Map(definitions.map((definition) => [definition.name, definition.description]))

  const proposals = buildDescriptions({
    plan,
    roles: { ...discovery.roles, ...config?.roles },
    events: discovery.events,
    existing,
    inferredRoles: discovery.inferredRoles,
  }).filter((proposal) => byName.has(proposal.event))

  const { apply, keptExisting } = toApply(proposals, { overwrite: argv.flags.overwrite === true })

  // -------------------------------------------------------------------------
  // Preview
  // -------------------------------------------------------------------------
  log.title(`Event descriptions for ${connection.client.hosts.host}`)
  log.info(`${definitions.length} event definitions in this project, ${proposals.length} describable`)

  if (!apply.length) {
    log.plain()
    if (keptExisting.length) {
      log.ok(`Nothing to do. ${keptExisting.length} events already have a description somebody wrote.`)
      log.info('Pass --overwrite to replace those too, if you are sure.')
    } else {
      log.ok('Every event OpenHog can describe already has the right description.')
    }
    return 0
  }

  log.plain()
  const preview = apply.slice(0, 12)
  for (const proposal of preview) {
    log.plain(`  ${color.bold(proposal.event)} ${color.grey(`(${SOURCE_LABEL[proposal.source]})`)}`)
    log.plain(`    ${color.grey(proposal.description.slice(0, 150))}`)
  }
  if (apply.length > preview.length) {
    log.info(`…and ${apply.length - preview.length} more`)
  }

  log.plain()
  const bySource = {
    plan: apply.filter((p) => p.source === 'plan').length,
    role: apply.filter((p) => p.source === 'role').length,
    behaviour: apply.filter((p) => p.source === 'behaviour').length,
  }
  log.info(
    `${apply.length} to write: ${bySource.plan} from the plan, ${bySource.role} from roles, ${bySource.behaviour} from behaviour.`,
  )
  if (keptExisting.length) {
    log.info(`${keptExisting.length} left alone because someone already wrote a description.`)
  }

  // -------------------------------------------------------------------------
  // Nothing is written without saying so
  // -------------------------------------------------------------------------
  if (argv.flags.write !== true) {
    log.plain()
    log.warn('This was a preview. Nothing was written.')
    log.info(`Run ${color.cyan('openhog describe --write')} to apply it to your PostHog project.`)
    log.info('These descriptions become visible to everyone in your organisation.')
    return 0
  }

  if (!isNonInteractive()) {
    log.plain()
    log.warn(`This writes to ${connection.client.hosts.host}, project ${connection.projectId}.`)
    log.info('Everyone in your PostHog organisation will see these descriptions.')
    if (!(await confirm(`Write ${apply.length} descriptions?`, false))) {
      log.info('Nothing written.')
      return 0
    }
  }

  // Rollback file first, so the previous state exists on disk before anything
  // changes. A tool that mutates a shared account owes people an undo.
  const rollbackPath = join(root, 'openhog-describe-rollback.json')
  writeJson(rollbackPath, {
    host: connection.client.hosts.host,
    projectId: connection.projectId,
    writtenAt: new Date().toISOString(),
    previous: apply.map((proposal) => ({
      event: proposal.event,
      definitionId: byName.get(proposal.event)?.id,
      description: proposal.existing ?? null,
      tags: byName.get(proposal.event)?.tags ?? [],
    })),
  })
  log.ok(`Previous values saved to ${color.cyan('openhog-describe-rollback.json')}`)

  // -------------------------------------------------------------------------
  // Canary, then the rest
  // -------------------------------------------------------------------------
  const written: string[] = []
  const failed: { event: string; error: string }[] = []

  const first = apply[0]!
  const firstId = byName.get(first.event)!.id
  try {
    await connection.client.updateEventDefinition(connection.projectId, firstId, {
      description: first.description,
      tags: mergeTags(byName.get(first.event)?.tags, first.tags),
    })
    // Read it back. A 200 that did not persist is worse than an error, because
    // the run would report success for four hundred events that did not change.
    const check = await connection.client.getEventDefinition(connection.projectId, firstId)
    if ((check.description ?? '').trim() !== first.description.trim()) {
      throw new PostHogError('PostHog accepted the write but the description did not persist.', {
        hint: 'This deployment may not support writing event definitions. Nothing else was attempted.',
      })
    }
    written.push(first.event)
  } catch (error) {
    log.fail('The first write did not take, so nothing else was attempted.')
    log.info(error instanceof PostHogError ? (error.hint ?? error.message) : String(error))
    log.info('Your project is unchanged apart from that one event. Please open an issue with:')
    log.info('https://github.com/ZakKrevitt/OpenHog/issues')
    return 1
  }

  const rest = apply.slice(1)
  if (rest.length) {
    const writing = spinner(`Writing ${rest.length} more…`)
    for (const [index, proposal] of rest.entries()) {
      const definition = byName.get(proposal.event)
      if (!definition) continue
      writing.update(`${index + 2}/${apply.length}  ${proposal.event}`)
      try {
        await connection.client.updateEventDefinition(connection.projectId, definition.id, {
          description: proposal.description,
          tags: mergeTags(definition.tags, proposal.tags),
        })
        written.push(proposal.event)
      } catch (error) {
        failed.push({
          event: proposal.event,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      // PostHog rate limits, and several hundred sequential PATCHes is exactly
      // the shape it limits.
      await new Promise((resolve) => setTimeout(resolve, 60))
    }
    writing.stop()
  }

  log.plain()
  log.ok(`${written.length} event descriptions are now live in PostHog.`)
  log.info(`${connection.client.hosts.host}/project/${connection.projectId}/data-management/events`)
  if (failed.length) {
    log.warn(`${failed.length} failed:`)
    for (const failure of failed.slice(0, 5)) log.info(`${failure.event}: ${failure.error.slice(0, 120)}`)
  }
  log.plain()
  log.info('To undo, keep openhog-describe-rollback.json: it holds every previous value.')

  return failed.length ? 1 : 0
}

/** Keep whatever tags the project already had; add ours without duplicating. */
function mergeTags(existing: string[] | undefined, added: string[]): string[] {
  return [...new Set([...(existing ?? []), ...added])]
}

export type { ProposedDescription }
