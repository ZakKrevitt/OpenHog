#!/usr/bin/env node
/**
 * The command line. Hand-rolled argument parsing so the package has zero
 * runtime dependencies: `npx openhog` should install in a second and be
 * auditable in an afternoon, and a tool that asks for an API key has to earn
 * that kind of trust.
 */

import { color, log, setQuiet } from './util/log.js'
import { setAssumeYes } from './util/prompt.js'
import { PostHogError } from './posthog/client.js'

export interface Argv {
  command: string
  positionals: string[]
  flags: Record<string, string | boolean>
}

export function parseArgs(argv: string[]): Argv {
  // `openhog --help` and `openhog --version` have no command, so a leading flag
  // must not be consumed as one.
  const leadsWithFlag = argv[0]?.startsWith('-') ?? true
  const command = leadsWithFlag ? 'help' : argv[0]!
  const rest = leadsWithFlag ? argv : argv.slice(1)
  const positionals: string[] = []
  const flags: Record<string, string | boolean> = {}

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!
    if (token.startsWith('--')) {
      const [name, inline] = token.slice(2).split('=')
      if (!name) continue
      if (inline !== undefined) {
        flags[name] = inline
      } else {
        const next = rest[index + 1]
        if (next && !next.startsWith('-')) {
          flags[name] = next
          index += 1
        } else {
          flags[name] = true
        }
      }
    } else if (token.startsWith('-') && token.length > 1) {
      for (const letter of token.slice(1)) flags[letter] = true
    } else {
      positionals.push(token)
    }
  }

  return { command, positionals, flags }
}

const HELP = `
${color.bold('openhog')} - make your PostHog data actionable, understandable,
          and dead simple to use.

${color.bold('USAGE')}
  npx openhog <command> [options]

${color.bold('COMMANDS')}
  ${color.cyan('explain')}    ${color.bold('Read your PostHog data and tell you what to do about it')}
             No repo, no config, no code changes. Just a key.
  ${color.cyan('init')}       Scan the repo, write a tracking plan, build dashboards, write the guide
  ${color.cyan('sync')}       Rebuild dashboards from the tracking plan (run after editing it)
  ${color.cyan('doctor')}     Why is nothing arriving? Checks CSP, keys, SDK config, live ingest
  ${color.cyan('check')}      Has the code drifted from the plan? Exits 1 on drift. Good in a hook
  ${color.cyan('demo')}       Seed realistic synthetic data so the dashboards are not empty
  ${color.cyan('plan')}       Print the tracking plan as a readable summary
  ${color.cyan('auth')}       Connect, re-connect or check your PostHog personal API key
  ${color.cyan('selftest')}   Check every query OpenHog uses actually runs on your PostHog
  ${color.cyan('mcp')}        Run the MCP server, so an AI agent can read your analytics

${color.bold('COMMON OPTIONS')}
  --cwd <path>        Repository root (default: the working directory)
  --region <us|eu>    PostHog cloud region (default: us)
  --host <url>        Self-hosted PostHog URL (implies --region custom)
  --project <id>      PostHog project id
  --yes, -y           Take every default. No prompts
  --quiet             Only print errors
  --json              Machine-readable output where supported

${color.bold('EXAMPLES')}
  npx openhog explain                   ${color.grey('# what is wrong with my product?')}
  npx openhog explain --open            ${color.grey('# and open the shareable report')}
  npx openhog init                      ${color.grey('# the one-command setup')}
  npx openhog init --region eu --yes    ${color.grey('# unattended, EU cloud')}
  npx openhog doctor                    ${color.grey('# nothing is showing up in PostHog')}
  npx openhog check --strict            ${color.grey('# in a pre-push hook')}
  npx openhog demo --people 800         ${color.grey('# make the dashboards look alive')}

${color.grey('Docs: https://github.com/ZakKrevitt/OpenHog')}
`

async function main(): Promise<number> {
  const argv = parseArgs(process.argv.slice(2))

  if (argv.flags.quiet) setQuiet(true)
  if (argv.flags.yes || argv.flags.y) setAssumeYes(true)

  // Version is checked first: with no command, `--version` parses as the help
  // command plus a version flag, and checking help first swallowed it.
  if (argv.flags.version || argv.flags.v || argv.command === 'version') {
    process.stdout.write('openhog 0.1.0\n')
    return 0
  }
  if (argv.flags.help || argv.flags.h || argv.command === 'help') {
    process.stdout.write(HELP)
    return 0
  }

  switch (argv.command) {
    case 'explain':
    case 'diagnose': {
      const { runExplain } = await import('./commands/explain.js')
      return runExplain(argv)
    }
    case 'init': {
      const { runInit } = await import('./commands/init.js')
      return runInit(argv)
    }
    case 'sync': {
      const { runSync } = await import('./commands/sync.js')
      return runSync(argv)
    }
    case 'doctor': {
      const { runDoctorCommand } = await import('./commands/doctor.js')
      return runDoctorCommand(argv)
    }
    case 'check': {
      const { runCheck } = await import('./commands/check.js')
      return runCheck(argv)
    }
    case 'demo': {
      const { runDemo } = await import('./commands/demo.js')
      return runDemo(argv)
    }
    case 'plan': {
      const { runPlan } = await import('./commands/plan.js')
      return runPlan(argv)
    }
    case 'auth': {
      const { runAuth } = await import('./commands/auth.js')
      return runAuth(argv)
    }
    case 'selftest': {
      const { runSelftest } = await import('./commands/selftest.js')
      return runSelftest(argv)
    }
    case 'mcp': {
      const { runMcp } = await import('./mcp/server.js')
      return runMcp(argv)
    }
    default:
      log.fail(`Unknown command: ${argv.command}`)
      process.stdout.write(HELP)
      return 1
  }
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    if (error instanceof PostHogError) {
      log.fail(error.message)
      if (error.hint) log.info(error.hint)
    } else {
      log.fail(error instanceof Error ? error.message : String(error))
      if (process.env.OPENHOG_DEBUG && error instanceof Error) {
        process.stderr.write(`${error.stack}\n`)
      } else {
        log.info('Run again with OPENHOG_DEBUG=1 for a stack trace.')
      }
    }
    process.exitCode = 1
  })
