/**
 * `openhog sync` — rebuild the dashboards from the tracking plan.
 *
 * Run after editing the plan, after adding events, or after pulling a new
 * version of OpenHog with better packs. Re-scans first, so newly instrumented
 * events unlock their charts without anyone remembering to update the plan.
 */

import { join } from 'node:path'
import type { Argv } from '../cli.js'
import { scan } from '../scan/index.js'
import { generatePlan, planStats } from '../plan/generate.js'
import { resolvePacks } from '../packs/index.js'
import { buildDashboards, reportSkipped, syncDashboards } from '../posthog/sync.js'
import { emitWalkthrough } from '../emit/walkthrough.js'
import { loadPlan, savePlan, DEFAULT_WALKTHROUGH_PATH } from '../config.js'
import { color, log, spinner } from '../util/log.js'
import { writeText } from '../util/fs.js'
import { connect, requireConfig, rootFrom } from './shared.js'

export async function runSync(argv: Argv): Promise<number> {
  const root = rootFrom(argv)
  const config = requireConfig(root)

  const scanSpinner = spinner('Re-reading the codebase…')
  const result = scan(root, { ignore: config.ignore })
  scanSpinner.stop()

  const existing = loadPlan(root, config)
  const plan = generatePlan({
    scan: result,
    kind: config.product.kind,
    packs: config.product.packs,
    existing,
  })
  const stats = planStats(plan)
  savePlan(root, config, plan)

  log.ok(`${stats.emitted} events emitted, ${stats.suggested} still suggested.`)

  const packs = resolvePacks(config.product.packs)
  const dashboards = buildDashboards(plan, packs)
  if (!dashboards.length) {
    log.warn('No dashboards could be built. None of the required events are emitted yet.')
    return 0
  }

  const connection = await connect(argv)
  const syncSpinner = spinner('Validating and syncing…')
  const synced = await syncDashboards({
    client: connection.client,
    projectId: connection.projectId,
    dashboards,
    validate: argv.flags['no-validate'] !== true,
    // A sync is explicitly a rebuild, so replacing is the useful default here
    // (unlike init, where leaving an existing dashboard alone is safer).
    replace: argv.flags['no-replace'] !== true,
    onProgress: (message) => syncSpinner.update(message),
  })
  syncSpinner.stop()

  for (const dashboard of synced.created) {
    log.ok(`${dashboard.name} ${color.grey(`(${dashboard.tiles.length} charts)`)} → ${dashboard.url}`)
  }
  if (synced.invalid.length) {
    log.warn(`${synced.invalid.length} charts failed validation and were skipped.`)
    for (const item of synced.invalid.slice(0, 10)) {
      log.info(`${item.dashboard} › ${item.tile}: ${item.error.slice(0, 160)}`)
    }
  }

  const walkthrough = emitWalkthrough({
    plan,
    dashboards,
    created: synced.created,
    skipped: reportSkipped(plan, packs),
    projectUrl: `${connection.client.hosts.host}/project/${connection.projectId}`,
    analyticsModulePath: config.paths?.analyticsModule,
  })
  const walkthroughPath = config.paths?.walkthrough ?? DEFAULT_WALKTHROUGH_PATH
  writeText(join(root, walkthroughPath), walkthrough)
  log.ok(`Rewrote ${color.cyan(walkthroughPath)}`)

  return 0
}
