/**
 * `openhog doctor` - the command people will share.
 *
 * Works without a config file and without a PostHog connection, degrading to
 * whatever it can check, because the person running it is usually mid-panic
 * about an empty dashboard and should not have to set something up first.
 */

import type { Argv } from '../cli.js'
import { runDoctor, doctorExitCode, type CheckResult } from '../doctor/index.js'
import { scan } from '../scan/index.js'
import { loadConfig, loadPlan } from '../config.js'
import { color, log, spinner } from '../util/log.js'
import { connect, rootFrom } from './shared.js'

const ICON: Record<CheckResult['status'], string> = {
  pass: color.green('✓'),
  warn: color.yellow('!'),
  fail: color.red('✗'),
  skip: color.grey('·'),
}

export async function runDoctorCommand(argv: Argv): Promise<number> {
  const root = rootFrom(argv)
  const config = loadConfig(root)
  const plan = loadPlan(root, config)

  const scanSpinner = spinner('Reading the codebase…')
  const result = scan(root, { ignore: config?.ignore })
  scanSpinner.stop()

  // A connection makes the live checks possible but is never required: the
  // static checks are the ones that find the cause most of the time.
  let client = null
  let projectId: number | undefined
  let publicKey: string | undefined
  if (argv.flags.offline !== true) {
    try {
      const connection = await connect(argv)
      client = connection.client
      projectId = connection.projectId
      publicKey = connection.publicKey
    } catch (error) {
      log.warn(`Running the offline checks only: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const liveSpinner = spinner('Checking…')
  const results = await runDoctor({
    root,
    config,
    plan,
    scan: result,
    client,
    projectId,
    publicKey,
    offline: argv.flags.offline === true,
    onProgress: (message) => liveSpinner.update(message),
  })
  liveSpinner.stop()

  if (argv.flags.json) {
    process.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`)
    return doctorExitCode(results)
  }

  log.title('OpenHog doctor')
  for (const check of results) {
    log.plain(`${ICON[check.status]} ${color.bold(check.name)}`)
    log.plain(`    ${check.status === 'pass' ? color.grey(check.message) : check.message}`)
    if (check.fix && check.status !== 'pass') {
      log.plain(`    ${color.cyan('fix:')} ${check.fix}`)
    }
    if (check.docs && check.status !== 'pass') {
      log.plain(`    ${color.grey(`https://github.com/ZakKrevitt/OpenHog/blob/main/docs/${check.docs}`)}`)
    }
    log.plain()
  }

  const failures = results.filter((check) => check.status === 'fail').length
  const warnings = results.filter((check) => check.status === 'warn').length

  if (failures === 0 && warnings === 0) {
    log.ok('Everything checks out.')
  } else {
    log.plain(
      `${failures ? color.red(`${failures} failing`) : ''}${failures && warnings ? ', ' : ''}${
        warnings ? color.yellow(`${warnings} to look at`) : ''
      }`,
    )
  }
  log.plain()

  return doctorExitCode(results)
}
