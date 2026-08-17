/**
 * The terminal report.
 *
 * Ordered so that someone who reads only the first screen still gets the most
 * important thing. Findings come before numbers, because a table of metrics is
 * what every other tool already gives you and it is not what anybody needs.
 */

import { color, log } from '../util/log.js'
import { formatMetric, type MetricSet } from '../metrics/types.js'
import { metricById } from '../metrics/definitions.js'
import { typicalRange } from '../insights/benchmarks.js'
import type { Finding, Severity } from '../insights/findings.js'
import { healthScore } from '../insights/findings.js'
import { GOAL_DEFINITIONS, type GoalContext } from '../insights/goals.js'

const BADGE: Record<Severity, string> = {
  critical: color.red('● CRITICAL'),
  warning: color.yellow('● WORTH FIXING'),
  opportunity: color.blue('● BLIND SPOT'),
  strength: color.green('● WORKING WELL'),
}

/** Wrap prose to a readable width, indented. */
function wrap(text: string, width = 76, indent = '     '): string[] {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    if ((line + word).length + 1 > width) {
      lines.push(indent + line.trim())
      line = ''
    }
    line += `${word} `
  }
  if (line.trim()) lines.push(indent + line.trim())
  return lines
}

export function renderTerminalReport(
  set: MetricSet,
  findings: Finding[],
  goal: GoalContext | null = null,
): void {
  const context = set.context

  log.plain()
  log.plain(`  ${color.bold(context.projectName)} ${color.grey(`· ${context.productKind}`)}`)
  log.plain(
    `  ${color.grey(
      `${formatMetric(context.activePeople, 'count')} people · ${formatMetric(context.totalEvents, 'count')} events · ${context.daysOfData} days of history · ${context.eventVolumes.length} event types`,
    )}`,
  )

  const score = healthScore(findings, set)
  if (score) {
    const tone = score.score >= 75 ? color.green : score.score >= 50 ? color.yellow : color.red
    log.plain()
    log.plain(`  ${tone(color.bold(`${score.score}/100`))} ${color.grey('product health')}`)
  }

  const counts = {
    critical: findings.filter((finding) => finding.severity === 'critical').length,
    warning: findings.filter((finding) => finding.severity === 'warning').length,
    opportunity: findings.filter((finding) => finding.severity === 'opportunity').length,
    strength: findings.filter((finding) => finding.severity === 'strength').length,
  }
  log.plain(
    `  ${color.grey(
      [
        counts.critical ? color.red(`${counts.critical} critical`) : '',
        counts.warning ? color.yellow(`${counts.warning} worth fixing`) : '',
        counts.opportunity
          ? color.blue(`${counts.opportunity} blind spot${counts.opportunity === 1 ? '' : 's'}`)
          : '',
        counts.strength ? color.green(`${counts.strength} working well`) : '',
      ]
        .filter(Boolean)
        .join(color.grey(' · ')),
    )}`,
  )

  // The goal leads, whether or not anything is wrong with it. Somebody who said
  // what they are working on should see its number before anything else.
  if (goal) {
    const definition = GOAL_DEFINITIONS[goal.focus]
    const metric = set.values[definition.headlineMetric]
    const definitionFor = metricById(definition.headlineMetric)
    log.plain()
    log.plain(`  ${color.bold('YOUR GOAL')}  ${color.grey(definition.label)}`)
    if (metric?.value != null && definitionFor) {
      const typical = typicalRange(definition.headlineMetric, context.productKind)
      log.plain(
        `  ${definitionFor.name}: ${color.bold(formatMetric(metric.value, definitionFor.unit))}` +
          `${typical ? color.grey(`   typical ${typical}`) : ''}`,
      )
    } else {
      log.plain(`  ${color.red('This project cannot currently measure it. See the first finding.')}`)
    }
    if (goal.note) log.plain(`  ${color.grey(goal.note)}`)
  }

  if (!findings.length) {
    log.plain()
    log.warn('Not enough data to draw any conclusions yet.')
    log.info('Come back once a few hundred people have used the product.')
    return
  }

  // -------------------------------------------------------------------------
  // Findings
  // -------------------------------------------------------------------------
  let index = 0
  for (const finding of findings) {
    index += 1
    log.plain()
    const goalTag = finding.goalRelevant ? color.cyan('  ← your goal') : ''
    log.plain(
      `  ${BADGE[finding.severity]}${finding.confidence === 'medium' ? color.grey('  (small sample)') : ''}${goalTag}`,
    )
    log.plain(`  ${color.bold(`${index}. ${finding.title}`)}`)
    log.plain()
    for (const line of wrap(finding.what)) log.plain(color.grey(line))
    log.plain()
    for (const line of wrap(finding.why)) log.plain(line)
    log.plain()
    log.plain(`     ${color.cyan('→')} ${color.bold('Do this:')}`)
    for (const line of wrap(finding.action, 72, '       ')) log.plain(line)

    if (finding.evidence.length) {
      log.plain()
      for (const item of finding.evidence) {
        const typical = item.typical ? color.grey(`  (typical: ${item.typical})`) : ''
        log.plain(`     ${color.grey(item.label.padEnd(26))} ${color.bold(item.value)}${typical}`)
      }
    }
  }

  // -------------------------------------------------------------------------
  // The numbers
  // -------------------------------------------------------------------------
  log.plain()
  log.plain(`  ${color.bold('EVERY NUMBER')}`)
  log.plain()
  for (const [id, metric] of Object.entries(set.values)) {
    const definition = metricById(id)
    if (!definition) continue
    if (metric.value === null) continue
    const typical = typicalRange(id, context.productKind)
    const flag = metric.confidence === 'low' ? color.grey(' ~') : '  '
    log.plain(
      `  ${definition.name.padEnd(28)}${flag}${color.bold(formatMetric(metric.value, definition.unit).padStart(8))}` +
        `${typical ? color.grey(`   typical ${typical}`) : ''}`,
    )
  }

  if (context.unavailable.length) {
    log.plain()
    log.plain(`  ${color.grey(`${context.unavailable.length} metrics could not be computed:`)}`)
    for (const item of context.unavailable.slice(0, 6)) {
      log.plain(`  ${color.grey(`  ${metricById(item.id)?.name ?? item.id}: ${item.reason.slice(0, 90)}`)}`)
    }
  }

  // -------------------------------------------------------------------------
  // How it read the project
  // -------------------------------------------------------------------------
  const roles = Object.entries(context.roles)
  if (roles.length) {
    log.plain()
    log.plain(`  ${color.bold('HOW IT READ YOUR EVENTS')} ${color.grey('- wrong? pass --role name=your_event')}`)
    log.plain()
    for (const [role, event] of roles.slice(0, 14)) {
      const guessed = context.inferredRoles.includes(role)
        ? color.yellow('  guessed from behaviour, check this')
        : ''
      log.plain(`  ${color.cyan(role.padEnd(24))} ${color.grey('→')} ${event}${guessed}`)
    }
    if (context.inferredRoles.length) {
      log.plain()
      log.info('Roles marked "guessed" were matched on how the event behaves, not what it')
      log.info('is called, because no name matched. Worth a look before trusting them.')
    }
  }
  log.plain()
}
