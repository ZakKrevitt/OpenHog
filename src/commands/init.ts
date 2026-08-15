/**
 * `openhog init` — the one command.
 *
 * Scan, understand, plan, instrument, build, document. Every destructive step
 * asks first and every step can be skipped, because this runs against
 * repositories nobody has vetted and the fastest way to lose someone's trust is
 * to write a file they did not expect.
 */

import { join } from 'node:path'
import type { Argv } from '../cli.js'
import type { ProductKind, TrackingPlan } from '../types.js'
import { PRODUCT_KINDS } from '../types.js'
import { scan } from '../scan/index.js'
import { guessProductKind } from '../scan/product.js'
import { generatePlan, planStats } from '../plan/generate.js'
import { packsForKind, resolvePacks } from '../packs/index.js'
import { buildDashboards, reportSkipped, syncDashboards } from '../posthog/sync.js'
import { emitAnalyticsModule, emitWiringSnippet } from '../emit/analyticsTs.js'
import { emitWalkthrough } from '../emit/walkthrough.js'
import { seedDemoData } from '../demo/seed.js'
import {
  analyticsModulePathFor,
  buildConfig,
  envStyleFor,
  loadPlan,
  publicKeyEnvFor,
  saveConfig,
  savePlan,
  DEFAULT_WALKTHROUGH_PATH,
} from '../config.js'
import { color, log, spinner } from '../util/log.js'
import { confirm, isNonInteractive, select } from '../util/prompt.js'
import { exists, readIfSmall, writeText } from '../util/fs.js'
import { connect, rootFrom } from './shared.js'

export async function runInit(argv: Argv): Promise<number> {
  const root = rootFrom(argv)

  log.plain()
  log.plain(`  ${color.bold('OpenHog')} ${color.grey('— analytics that match your product')}`)
  log.plain()

  // -------------------------------------------------------------------------
  // 1. Scan
  // -------------------------------------------------------------------------
  const scanSpinner = spinner('Reading the codebase…')
  const result = scan(root)
  scanSpinner.stop()

  log.title('What this repository looks like')
  log.plain(`  ${color.bold(result.product.name)}`)
  log.plain(`  ${color.grey(result.product.description.slice(0, 200))}`)
  log.plain()
  log.info(`${result.filesScanned} files · ${result.frameworks.join(', ')} · ${result.surfaces.join(' + ')}`)
  log.info(`${result.routes.length} routes · ${result.existingEvents.length} events already emitted`)
  if (result.existingAnalytics.length) {
    log.info(`analytics already present: ${result.existingAnalytics.join(', ')}`)
  }
  const activeSignals = Object.entries(result.signals)
    .filter(([, value]) => value)
    .map(([key]) => key.replace(/^has/, '').toLowerCase())
  if (activeSignals.length) log.info(`features detected: ${activeSignals.join(', ')}`)

  // -------------------------------------------------------------------------
  // 2. Product kind
  // -------------------------------------------------------------------------
  const guess = guessProductKind(
    result.signals,
    [result.product.name, result.product.description, ...result.product.evidence].join(' '),
  )
  log.plain()
  for (const reason of guess.reasons.slice(0, 4)) log.info(reason)

  const kind = (typeof argv.flags.kind === 'string' && PRODUCT_KINDS.includes(argv.flags.kind as ProductKind)
    ? (argv.flags.kind as ProductKind)
    : await select<ProductKind>(
        'What kind of product is this? It decides which dashboards you get.',
        [
          { value: 'saas', label: 'SaaS', hint: 'accounts, subscriptions, teams' },
          { value: 'consumer', label: 'Consumer app', hint: 'social, feeds, habit' },
          { value: 'marketplace', label: 'Marketplace', hint: 'two sides, listings' },
          { value: 'ecommerce', label: 'Ecommerce', hint: 'cart and checkout' },
          { value: 'ai-app', label: 'AI product', hint: 'generation, prompts, quality' },
          { value: 'devtool', label: 'Developer tool', hint: 'time to first success' },
          { value: 'content', label: 'Content / publication', hint: 'reading depth, subscribers' },
        ],
        guess.kind,
      ))

  const packs = packsForKind(kind)
  log.ok(`${kind} — using the ${packs.map((pack) => pack.name).join(' and ')} packs.`)

  // -------------------------------------------------------------------------
  // 3. Connect to PostHog
  // -------------------------------------------------------------------------
  const connection = await connect(argv)
  const publicKeyEnv = publicKeyEnvFor(result.frameworks)

  // -------------------------------------------------------------------------
  // 4. Tracking plan
  // -------------------------------------------------------------------------
  const analyticsModulePath = analyticsModulePathFor(root, result.entryFile)
  const config = buildConfig({
    region: connection.config?.posthog.region ?? (typeof argv.flags.region === 'string' ? (argv.flags.region as 'us' | 'eu') : 'us'),
    customHost: typeof argv.flags.host === 'string' ? argv.flags.host : undefined,
    projectId: connection.projectId,
    publicKeyEnv,
    kind,
    packs: packs.map((pack) => pack.id),
    analyticsModulePath,
  })

  const existingPlan: TrackingPlan | null = loadPlan(root, config)
  const plan = generatePlan({ scan: result, kind, packs: packs.map((pack) => pack.id), existing: existingPlan })
  const stats = planStats(plan)

  log.title('Tracking plan')
  log.info(`${stats.emitted} events your code emits, ${stats.suggested} worth adding.`)
  log.info(`${stats.rolesResolved} of ${stats.rolesTotal} dashboard roles resolved to a real event.`)

  if (stats.emitted === 0) {
    log.warn('This codebase does not appear to emit any analytics events yet.')
    log.info('OpenHog will still set up PostHog, the analytics module and the plan, but')
    log.info('most dashboards need events to exist first. Add a few, then run `openhog sync`.')
  }

  const planFile = savePlan(root, config, plan)
  saveConfig(root, config)
  log.ok(`Wrote ${color.cyan(planFile.replace(`${root}/`, ''))} and ${color.cyan('openhog.config.json')}`)

  // -------------------------------------------------------------------------
  // 5. Analytics module
  // -------------------------------------------------------------------------
  const modulePath = join(root, analyticsModulePath)
  const isWebSurface = result.surfaces.includes('web')
  const moduleExists = exists(modulePath)

  // Never clobber a file somebody wrote. An existing analytics module is the
  // most likely file in the repo to contain hand-tuned behaviour, and silently
  // replacing it would be the single worst thing this tool could do.
  const shouldWriteModule =
    isWebSurface &&
    (moduleExists
      ? argv.flags['overwrite-analytics'] === true ||
        (await confirm(
          `${color.cyan(analyticsModulePath)} already exists. Replace it with the OpenHog module?`,
          false,
        ))
      : await confirm(`Write a hardened analytics module to ${color.cyan(analyticsModulePath)}?`, true))

  if (shouldWriteModule) {
    writeText(
      modulePath,
      emitAnalyticsModule({
        plan,
        publicKeyEnv,
        ingestHost: config.posthog.ingestHost,
        envStyle: envStyleFor(result.frameworks),
      }),
    )
    log.ok(`Wrote ${color.cyan(analyticsModulePath)}`)
    log.info('It sends $pageview by hand, normalises URLs, queues boot-time events,')
    log.info('and keeps replay off your sensitive routes. See ANALYTICS.md for why each matters.')

    const snippet = emitWiringSnippet(result.frameworks[0] ?? 'react', `./${analyticsModulePath.split('/').pop()}`)
    log.plain()
    log.plain(`  ${color.bold('Wire it up')} ${color.grey(`in ${result.entryFile ?? 'your app entry'}:`)}`)
    log.plain()
    for (const line of snippet.trimEnd().split('\n')) log.plain(`    ${color.grey(line)}`)
    log.plain()
  } else if (moduleExists && isWebSurface) {
    log.info(`Kept your existing ${analyticsModulePath}.`)
    log.info('Run `openhog doctor` to check it against the four production traps,')
    log.info('or `openhog init --overwrite-analytics` to replace it with the generated module.')
  }

  // -------------------------------------------------------------------------
  // 6. Environment variables
  // -------------------------------------------------------------------------
  if (connection.publicKey) {
    await writeEnvExample(root, publicKeyEnv, connection.publicKey, config.posthog.ingestHost)
  }

  // -------------------------------------------------------------------------
  // 7. Dashboards
  // -------------------------------------------------------------------------
  log.title('Building dashboards')
  const dashboards = buildDashboards(plan, packs)
  const tileTotal = dashboards.reduce((total, dashboard) => total + dashboard.tiles.length, 0)

  if (!dashboards.length) {
    log.warn('No dashboards could be built: none of the required events are emitted yet.')
    log.info('Add some events, then run `openhog sync`.')
  } else {
    log.info(`${dashboards.length} dashboards, ${tileTotal} charts, all built on events your code emits.`)
    const syncSpinner = spinner('Validating every query against your project…')
    const synced = await syncDashboards({
      client: connection.client,
      projectId: connection.projectId,
      dashboards,
      validate: argv.flags['no-validate'] !== true,
      replace: argv.flags.replace === true,
      onProgress: (message) => syncSpinner.update(message),
    })
    syncSpinner.stop()

    for (const dashboard of synced.created) {
      log.ok(`${dashboard.name} ${color.grey(`(${dashboard.tiles.length} charts)`)}`)
      log.info(dashboard.url)
    }
    for (const name of synced.skippedExisting) {
      log.warn(`${name} already existed; left it alone. Re-run with --replace to rebuild it.`)
    }
    if (synced.invalid.length) {
      log.plain()
      log.warn(`${synced.invalid.length} charts did not validate and were not created:`)
      for (const item of synced.invalid.slice(0, 8)) {
        log.info(`${item.dashboard} › ${item.tile}: ${item.error.slice(0, 160)}`)
      }
      log.info('These are usually HogQL differences on self-hosted versions. Please open an issue.')
    }

    // ---------------------------------------------------------------------
    // 8. Walkthrough
    // ---------------------------------------------------------------------
    const walkthrough = emitWalkthrough({
      plan,
      dashboards: dashboards.map((dashboard) => ({
        ...dashboard,
        tiles: dashboard.tiles.filter(
          (tile) => !synced.invalid.some((item) => item.dashboard === dashboard.name && item.tile === tile.name),
        ),
      })),
      created: synced.created,
      skipped: reportSkipped(plan, packs),
      projectUrl: `${connection.client.hosts.host}/project/${connection.projectId}`,
      analyticsModulePath,
    })
    const walkthroughPath = join(root, config.paths?.walkthrough ?? DEFAULT_WALKTHROUGH_PATH)
    writeText(walkthroughPath, walkthrough)
    log.ok(`Wrote ${color.cyan(config.paths?.walkthrough ?? DEFAULT_WALKTHROUGH_PATH)} — what every chart means and what to do when it moves.`)

    // ---------------------------------------------------------------------
    // 9. Demo data
    // ---------------------------------------------------------------------
    if (
      connection.publicKey &&
      stats.emitted > 0 &&
      !isNonInteractive() &&
      (await confirm('Seed realistic demo data so the dashboards are not empty?', false))
    ) {
      const seedSpinner = spinner('Seeding…')
      const seeded = await seedDemoData(connection.client, connection.publicKey, {
        plan,
        onProgress: (sent, total) => seedSpinner.update(`Seeding ${sent}/${total} events…`),
      })
      seedSpinner.stop()
      log.ok(`Sent ${seeded.sent} demo events. They are tagged is_demo_data:true and use openhog_demo_* person ids.`)
      log.info('Give PostHog a minute, then refresh the dashboards.')
    }
  }

  // -------------------------------------------------------------------------
  // 10. What next
  // -------------------------------------------------------------------------
  log.title('Done. Next:')
  log.plain(`  ${color.bold('1.')} Read ${color.cyan(config.paths?.walkthrough ?? 'ANALYTICS.md')} — it explains every chart.`)
  log.plain(`  ${color.bold('2.')} Set ${color.bold(publicKeyEnv)} in your hosting provider's environment.`)
  log.plain(`  ${color.bold('3.')} Deploy, then run ${color.cyan('npx openhog doctor')} to prove events are arriving.`)
  if (stats.suggested > 0) {
    log.plain(`  ${color.bold('4.')} ${stats.suggested} suggested events are listed in the plan. Each one unlocks charts.`)
  }
  log.plain()
  log.plain(`  ${color.grey('Add `npx openhog check` to your pre-push hook to catch instrumentation drift.')}`)
  log.plain()

  return 0
}

/**
 * Write `.env.example` and offer to write the real key into `.env.local`.
 * The example file is always safe to commit; the real one never is, so it is
 * opt-in and the gitignore is checked first.
 */
async function writeEnvExample(
  root: string,
  publicKeyEnv: string,
  publicKey: string,
  ingestHost: string,
): Promise<void> {
  const examplePath = join(root, '.env.example')
  const existing = readIfSmall(examplePath) ?? ''
  if (!existing.includes(publicKeyEnv)) {
    const block = [
      existing.trimEnd(),
      existing.trim() ? '' : null,
      '# PostHog. The project key is public by design: it can only send events.',
      `${publicKeyEnv}=phc_your_project_key`,
      `${publicKeyEnv.replace(/KEY$/, '')}HOST=${ingestHost}`,
      `# Session replay is off unless this is exactly "true".`,
      `${publicKeyEnv.replace(/KEY$/, '')}SESSION_RECORDING=false`,
      '',
    ]
      .filter((line) => line !== null)
      .join('\n')
    writeText(examplePath, block)
    log.ok(`Updated ${color.cyan('.env.example')}`)
  }

  const localPath = join(root, '.env.local')
  const gitignore = readIfSmall(join(root, '.gitignore')) ?? ''
  const ignored = /(^|\n)\.env(\.local)?\*?(\n|$)/.test(gitignore) || gitignore.includes('.env')

  if (!ignored) {
    log.warn('.env files are not gitignored here, so OpenHog will not write your key to one.')
    log.info(`Set ${publicKeyEnv}=${publicKey.slice(0, 12)}… yourself.`)
    return
  }

  const localContent = readIfSmall(localPath) ?? ''
  if (localContent.includes(publicKeyEnv)) return
  if (!(await confirm(`Write ${publicKeyEnv} into .env.local? (it is gitignored)`, true))) return

  writeText(
    localPath,
    `${localContent.trimEnd()}${localContent.trim() ? '\n\n' : ''}${publicKeyEnv}=${publicKey}\n${publicKeyEnv.replace(/KEY$/, '')}HOST=${ingestHost}\n`,
  )
  log.ok(`Wrote ${color.cyan('.env.local')}`)
}
