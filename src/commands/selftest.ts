/**
 * `openhog selftest` - does this tool actually work against YOUR PostHog?
 *
 * Every number in the report comes from a HogQL query, and HogQL is not one
 * language: PostHog Cloud, a six-month-old self-hosted deployment and a fresh
 * one differ in which functions exist and which syntax parses. A query that is
 * fine on Cloud can be a hard error elsewhere, and the failure would otherwise
 * show up as a silently missing section of somebody's report.
 *
 * So the query catalogue is executable on its own. This runs every query
 * against the connected project, reports exactly which ones your deployment can
 * answer, and prints the error PostHog gave for any that fail. It needs only
 * `query:read`, it is read-only, and it writes nothing.
 *
 * It is also how this package is verified before release. If you hit a failure
 * here, the output of `--json` is exactly what an issue needs.
 */

import type { Argv } from '../cli.js'
import { METRICS } from '../metrics/definitions.js'
import { discoverProject } from '../metrics/discover.js'
import { ALL_ROLES } from '../plan/roles.js'
import { color, log, spinner } from '../util/log.js'
import { connect } from './shared.js'

interface QueryResult {
  id: string
  name: string
  status: 'ok' | 'failed' | 'skipped'
  ms?: number
  rows?: number
  error?: string
  reason?: string
}

export async function runSelftest(argv: Argv): Promise<number> {
  const connection = await connect(argv)
  const results: QueryResult[] = []

  const progress = spinner('Reading the project...')

  // Discovery runs first and everything else depends on it, so a failure here
  // is worth reporting differently from one metric being unsupported.
  let daysOfData = 0
  let roles: Record<string, string> = {}
  try {
    const discovery = await discoverProject(connection.client, connection.projectId)
    daysOfData = discovery.daysOfData
    roles = discovery.roles
    results.push({
      id: '_discovery',
      name: 'Project discovery',
      status: 'ok',
      rows: discovery.events.length,
    })
  } catch (error) {
    progress.stop()
    log.fail('Discovery failed, so nothing else could be tested.')
    log.info(error instanceof Error ? error.message : String(error))
    log.info('This is the query that lists your event names. If it fails, please open an issue.')
    return 1
  }

  // Every role is filled so that every query builds and gets exercised, even
  // the ones this particular project could not otherwise reach.
  const probeRoles: Record<string, string> = { ...roles }
  const busiest = Object.values(roles)[0] ?? '$pageview'
  for (const role of ALL_ROLES) probeRoles[role] ??= busiest

  for (const metric of METRICS) {
    progress.update(metric.name)
    const built = metric.build({ roles: probeRoles, window: 30 })
    if (!built) {
      results.push({ id: metric.id, name: metric.name, status: 'skipped', reason: 'Not buildable' })
      continue
    }

    const started = Date.now()
    try {
      const response = await connection.client.query<{ results?: unknown[][] }>(
        connection.projectId,
        { kind: 'HogQLQuery', query: built.sql },
      )
      results.push({
        id: metric.id,
        name: metric.name,
        status: 'ok',
        ms: Date.now() - started,
        rows: response.results?.length ?? 0,
      })
    } catch (error) {
      results.push({
        id: metric.id,
        name: metric.name,
        status: 'failed',
        ms: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  progress.stop()

  const failed = results.filter((result) => result.status === 'failed')
  const ok = results.filter((result) => result.status === 'ok')

  if (argv.flags.json) {
    process.stdout.write(
      `${JSON.stringify({ host: connection.client.hosts.host, projectId: connection.projectId, daysOfData, results }, null, 2)}\n`,
    )
    return failed.length ? 1 : 0
  }

  log.title(`Query self-test against ${connection.client.hosts.host}`)
  log.info(`${daysOfData} days of history in this project`)
  log.plain()

  for (const result of results) {
    const mark =
      result.status === 'ok'
        ? color.green('ok  ')
        : result.status === 'failed'
          ? color.red('FAIL')
          : color.grey('skip')
    const timing = result.ms === undefined ? '' : color.grey(` ${result.ms}ms`)
    log.plain(`  ${mark}  ${result.name.padEnd(30)}${timing}`)
    if (result.error) log.plain(`        ${color.red(result.error.slice(0, 200))}`)
    if (result.reason) log.plain(`        ${color.grey(result.reason)}`)
  }

  log.plain()
  if (!failed.length) {
    log.ok(`All ${ok.length} queries ran on this deployment.`)
  } else {
    log.fail(`${failed.length} of ${results.length} queries failed on this deployment.`)
    log.info('Those metrics will be reported as unavailable rather than breaking the report.')
    log.info('Please open an issue with `openhog selftest --json`:')
    log.info('https://github.com/ZakKrevitt/OpenHog/issues')
  }

  // Metrics this project is simply too young for are not a tool failure, but
  // people should know why a section of their report will be thin.
  const tooYoung = METRICS.filter((metric) => metric.minDays && daysOfData < metric.minDays)
  if (tooYoung.length) {
    log.plain()
    log.warn(`${tooYoung.length} metrics need more history than this project has (${daysOfData} days):`)
    for (const metric of tooYoung) {
      log.info(`${metric.name} needs about ${metric.minDays} days`)
    }
    log.info('They are withheld rather than answered with a number that would not mean anything.')
  }

  return failed.length ? 1 : 0
}
