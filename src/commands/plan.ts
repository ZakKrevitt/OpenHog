/**
 * `openhog plan` — print the tracking plan as something a person can read in a
 * standup, rather than 900 lines of JSON.
 */

import type { Argv } from '../cli.js'
import { STAGES } from '../types.js'
import { loadConfig, loadPlan } from '../config.js'
import { planStats } from '../plan/generate.js'
import { ROLE_DESCRIPTIONS, type EventRole } from '../plan/roles.js'
import { color, log } from '../util/log.js'
import { rootFrom } from './shared.js'

export async function runPlan(argv: Argv): Promise<number> {
  const root = rootFrom(argv)
  const config = loadConfig(root)
  const plan = loadPlan(root, config)

  if (!plan) {
    log.fail('No tracking plan found. Run `npx openhog init` first.')
    return 1
  }

  if (argv.flags.json) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
    return 0
  }

  const stats = planStats(plan)

  log.title(plan.product.name)
  log.plain(`  ${color.grey(plan.product.description.slice(0, 180))}`)
  log.plain()
  log.info(`${plan.product.kind} · ${plan.product.surfaces.join(' + ')} · packs: ${plan.packs.join(', ')}`)
  log.info(`${stats.emitted} emitted · ${stats.suggested} suggested · ${stats.rolesResolved}/${stats.rolesTotal} roles resolved`)

  for (const stage of STAGES) {
    const events = plan.events.filter((event) => event.stage === stage)
    if (!events.length) continue
    log.plain()
    log.plain(`  ${color.bold(stage.toUpperCase())}`)
    for (const event of events) {
      const mark = event.emitted ? color.green('●') : color.grey('○')
      const where = event.emitted ? color.grey(event.sources[0] ?? '') : color.yellow('not implemented')
      log.plain(`    ${mark} ${event.name.padEnd(34)} ${where}`)
    }
  }

  const roles = Object.entries(plan.roles)
  if (roles.length) {
    log.plain()
    log.plain(`  ${color.bold('ROLE MAP')} ${color.grey('— how the dashboard packs found your events')}`)
    for (const [role, event] of roles) {
      log.plain(`    ${color.cyan(role.padEnd(24))} → ${event}`)
      const description = ROLE_DESCRIPTIONS[role as EventRole]
      if (description && argv.flags.verbose) log.plain(`      ${color.grey(description)}`)
    }
  }

  const unresolved = Object.keys(ROLE_DESCRIPTIONS).filter((role) => !plan.roles[role])
  if (unresolved.length) {
    log.plain()
    log.plain(`  ${color.bold('UNRESOLVED ROLES')} ${color.grey('— charts you are not getting')}`)
    for (const role of unresolved) {
      log.plain(`    ${color.grey(role.padEnd(24))} ${color.grey(ROLE_DESCRIPTIONS[role as EventRole] ?? '')}`)
    }
  }

  log.plain()
  return 0
}
