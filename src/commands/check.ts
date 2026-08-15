/**
 * `openhog check` — has the code drifted from the plan?
 *
 * No network, no API key, fast enough for a pre-commit hook. Exits 1 when an
 * event the plan says is emitted has vanished from the code, because that is
 * the case where a dashboard silently starts lying.
 */

import type { Argv } from '../cli.js'
import { checkDrift } from '../check.js'
import { scan } from '../scan/index.js'
import { loadConfig, loadPlan } from '../config.js'
import { color, log } from '../util/log.js'
import { rootFrom } from './shared.js'

export async function runCheck(argv: Argv): Promise<number> {
  const root = rootFrom(argv)
  const config = loadConfig(root)
  const plan = loadPlan(root, config)

  if (!plan) {
    log.fail('No tracking plan found. Run `npx openhog init` first.')
    return 1
  }

  const result = scan(root, { ignore: config?.ignore })
  const report = checkDrift({ plan, scan: result, strict: argv.flags.strict === true })

  if (argv.flags.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return report.errors.length ? 1 : 0
  }

  const { stats } = report
  log.info(
    `${stats.planned} planned · ${stats.emitted} emitted · ${stats.unimplemented} not implemented · ${stats.routesTotal} routes`,
  )

  if (!report.drift.length) {
    log.ok('The code and the tracking plan agree.')
    return 0
  }

  const groups: [string, string, typeof report.drift][] = [
    ['removed', 'Events the plan expects that the code no longer emits', report.drift.filter((item) => item.kind === 'removed')],
    ['role-lost', 'Dashboard roles that no longer resolve', report.drift.filter((item) => item.kind === 'role-lost')],
    ['added', 'Events in the code that are not in the plan', report.drift.filter((item) => item.kind === 'added')],
    ['untracked-route', 'Routes not in the plan', report.drift.filter((item) => item.kind === 'untracked-route')],
    ['unimplemented', 'Suggested events still not implemented', report.drift.filter((item) => item.kind === 'unimplemented')],
  ]

  for (const [kind, heading, items] of groups) {
    if (!items.length) continue
    const isError = kind === 'removed' || kind === 'role-lost' || (argv.flags.strict === true && kind === 'added')
    log.plain()
    log.plain(`${isError ? color.red('✗') : color.yellow('!')} ${color.bold(heading)} (${items.length})`)
    for (const item of items.slice(0, 15)) {
      log.plain(`    ${color.bold(item.name)}`)
      log.plain(`      ${color.grey(item.detail)}`)
    }
    if (items.length > 15) log.info(`  …and ${items.length - 15} more`)
  }

  log.plain()
  if (report.errors.length) {
    log.fail(`${report.errors.length} problems that will make a dashboard wrong.`)
    log.info('Restore the missing call sites, or run `openhog sync` if the removal was intentional.')
    return 1
  }
  log.ok('Nothing broken. Run `openhog sync` to fold the new events into your dashboards.')
  return 0
}
