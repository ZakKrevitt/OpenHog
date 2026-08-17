/**
 * `openhog explain` - the whole product in one command.
 *
 * Deliberately needs nothing but a PostHog key. No repository, no config file,
 * no code changes, no instrumentation work. Somebody who has been sending
 * events for two years and has never got value out of them can run this and
 * have a ranked list of what to do in about thirty seconds.
 *
 * That is the point. Setting analytics up is a small market; being unable to
 * read the analytics you already have is close to universal.
 */

import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import type { Argv } from '../cli.js'
import { PRODUCT_KINDS, type ProductKind } from '../types.js'
import { computeMetrics } from '../metrics/compute.js'
import { deriveFindings, healthScore, summarise } from '../insights/findings.js'
import { renderTerminalReport } from '../report/terminal.js'
import { renderHtmlReport } from '../report/html.js'
import { loadConfig, loadPlan } from '../config.js'
import { writeText } from '../util/fs.js'
import { color, log, spinner } from '../util/log.js'
import { connect, rootFrom } from './shared.js'

/** `--role activation=item_created,share=share_click` */
function parseRoleOverrides(value: unknown): Record<string, string> {
  if (typeof value !== 'string') return {}
  const overrides: Record<string, string> = {}
  for (const pair of value.split(',')) {
    const [role, event] = pair.split('=').map((part) => part.trim())
    if (role && event) overrides[role] = event
  }
  return overrides
}

function openInBrowser(path: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  try {
    const child = spawn(command, [path], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' })
    child.unref()
  } catch {
    // Headless. The path is printed either way.
  }
}

export async function runExplain(argv: Argv): Promise<number> {
  const root = rootFrom(argv)

  // A repo is optional. When there is one, its tracking plan is a better source
  // of role mappings than anything inferred from event names alone, because it
  // was derived from the code rather than guessed from vocabulary.
  const config = loadConfig(root)
  const plan = loadPlan(root, config)

  const connection = await connect(argv)

  const kindFlag = typeof argv.flags.kind === 'string' ? argv.flags.kind : undefined
  const productKind: ProductKind | undefined =
    kindFlag && PRODUCT_KINDS.includes(kindFlag as ProductKind)
      ? (kindFlag as ProductKind)
      : (plan?.product.kind ?? config?.product.kind)

  // Least specific to most: what the code said, what somebody saved after
  // correcting it, then what this invocation asked for.
  const roles = { ...plan?.roles, ...config?.roles, ...parseRoleOverrides(argv.flags.role) }

  let projectName = `Project ${connection.projectId}`
  try {
    projectName = (await connection.client.getProject(connection.projectId)).name
  } catch {
    // project:read may be missing; the report just uses the id.
  }

  const progress = spinner('Reading your PostHog project…')
  const set = await computeMetrics({
    client: connection.client,
    projectId: connection.projectId,
    projectName,
    productKind,
    roles: Object.keys(roles).length ? roles : undefined,
    onProgress: (message) => progress.update(message),
  })
  progress.stop()

  const findings = deriveFindings(set)

  if (argv.flags.json) {
    process.stdout.write(
      `${JSON.stringify(
        { context: set.context, metrics: set.values, findings, score: healthScore(findings, set) },
        null,
        2,
      )}\n`,
    )
    return findings.some((finding) => finding.severity === 'critical') ? 1 : 0
  }

  renderTerminalReport(set, findings)

  // -------------------------------------------------------------------------
  // The shareable artefact
  // -------------------------------------------------------------------------
  if (argv.flags.html !== false) {
    const target =
      typeof argv.flags.html === 'string'
        ? resolve(argv.flags.html)
        : join(root, 'openhog-report.html')

    writeText(
      target,
      renderHtmlReport({
        set,
        findings,
        projectUrl: `${connection.client.hosts.host}/project/${connection.projectId}`,
      }),
    )
    log.ok(`Report written to ${color.cyan(target)}`)
    log.info('One file, no network calls, safe to send to anyone who should see it.')
    if (argv.flags.open) openInBrowser(target)
  }

  // -------------------------------------------------------------------------
  // The one-line version
  // -------------------------------------------------------------------------
  const critical = findings.filter((finding) => finding.severity === 'critical')
  log.plain()
  if (critical.length) {
    log.plain(`  ${color.bold('The one thing to do next:')}`)
    log.plain(`  ${color.red(summarise(findings))}`)
    log.plain(`  ${color.grey(critical[0]!.action.split('. ')[0]!)}.`)
  } else {
    log.plain(`  ${color.bold('Headline:')} ${summarise(findings)}`)
  }
  log.plain()

  if (!plan) {
    log.info('Run `npx openhog init` in your codebase to turn these findings into dashboards,')
    log.info('and to catch the instrumentation problems that only show up in production.')
  }

  return critical.length ? 1 : 0
}
