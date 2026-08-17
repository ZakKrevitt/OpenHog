/**
 * `openhog mcp` - an MCP server over stdio, with no SDK dependency.
 *
 * The point is not "AI integration" as a feature. It is that the loop of asking
 * a question about your product, writing the query, reading the answer and
 * changing the code is currently four tools and three context switches. With
 * this, the agent that just wrote the feature can ask what happened to it.
 *
 * The protocol surface is small (initialize, tools/list, tools/call), so it is
 * implemented directly rather than pulling in a dependency. MCP's stdio
 * transport is newline-delimited JSON-RPC 2.0.
 */

import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import type { Argv } from '../cli.js'
import { scan } from '../scan/index.js'
import { checkDrift } from '../check.js'
import { configPath, loadConfig, loadPlan, saveConfig } from '../config.js'
import { runDoctor } from '../doctor/index.js'
import { PostHogClient, hostsForRegion } from '../posthog/client.js'
import { resolvePersonalKey } from '../posthog/auth.js'
import { planStats } from '../plan/generate.js'
import { computeMetrics } from '../metrics/compute.js'
import { discoverProject } from '../metrics/discover.js'
import { buildDescriptions, toApply } from '../describe/descriptions.js'
import { ALL_ROLES, ROLE_DESCRIPTIONS } from '../plan/roles.js'
import { deriveFindings, healthScore, summarise } from '../insights/findings.js'

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: number | string | null
  method: string
  params?: Record<string, unknown>
}

const TOOLS = [
  {
    name: 'explain_product',
    description:
      'Read the PostHog project and return a ranked list of what is wrong with the product and what to do about it: retention, activation, funnel losses, friction, blind spots, and whether the instrumentation itself is trustworthy. Each finding carries the number, how it compares to typical for this kind of product, and one concrete next action. Use this whenever the user asks how the product is doing, what to work on next, why growth is flat, or what the analytics say.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          description: 'Override the inferred product type, which decides which benchmarks apply.',
          enum: ['saas', 'consumer', 'marketplace', 'ecommerce', 'ai-app', 'devtool', 'content'],
        },
      },
    },
  },
  {
    name: 'propose_role_mapping',
    description:
      "Returns this project's event names with their volumes, which semantic roles are still unmapped, and what each role means - so YOU can map the ones no pattern could. Use this whenever a report says a role was unresolved or 'guessed from behaviour', and whenever the project's events are not English snake_case. Vocabulary matching cannot cover domain jargon (kyc_passed, level_completed), abbreviations (usr_reg_ok) or languages it was not written for; you can. Read the events, decide which one plays each unmapped role, then call save_role_mapping with your answer.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'save_role_mapping',
    description:
      'Persist a role-to-event mapping so every future report uses it. Only map a role when you are confident from the event name, its volume, or the codebase; a wrong mapping silently changes what a finding claims, and leaving a role unmapped is always better than mapping it wrongly.',
    inputSchema: {
      type: 'object',
      properties: {
        roles: {
          type: 'object',
          description:
            'Role name to event name, e.g. {"signup_completed": "kyc_passed", "core_action": "transfer_sent"}. Event names must be ones this project actually sends.',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['roles'],
    },
  },
  {
    name: 'preview_event_descriptions',
    description:
      "Show what OpenHog would write into PostHog's own event definitions - the descriptions that appear in the event list, the insight builder and every picker, for everyone in the organisation. Read-only: it never writes. Use it to check the wording before telling the user to run `openhog describe --write`, which is the only command that changes what other people see and which always asks first.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_tracking_plan',
    description:
      'The events this product measures, what each one means, whether the code currently emits it, and the role each plays in the dashboards. Read this before adding any analytics call, so the new event matches the existing vocabulary instead of inventing a synonym.',
    inputSchema: {
      type: 'object',
      properties: {
        stage: {
          type: 'string',
          description: 'Filter to one lifecycle stage.',
          enum: ['acquisition', 'activation', 'engagement', 'conversion', 'retention', 'referral', 'health'],
        },
      },
    },
  },
  {
    name: 'query_analytics',
    description:
      'Run a HogQL (ClickHouse SQL) query against the PostHog `events` table and get rows back. Columns available: event, timestamp, distinct_id, properties (a JSON map, access as properties.foo), $session_id. Always bound the time range. Use this to answer questions about what real users did.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            "HogQL, e.g. \"SELECT event, count() FROM events WHERE timestamp > now() - INTERVAL 7 DAY GROUP BY event ORDER BY 2 DESC LIMIT 20\". Note the API applies a 100-row default limit unless you pass an explicit LIMIT.",
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_dashboards',
    description: 'The dashboards in the PostHog project, with their ids and URLs.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'check_instrumentation_drift',
    description:
      'Compare the tracking plan against what the code emits right now. Returns events that vanished (which means a dashboard is silently wrong), events added without a plan entry, and dashboard roles that no longer resolve. Run this after refactoring anything that touches analytics.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'diagnose_analytics',
    description:
      'Run the full OpenHog doctor: CSP directives, environment variables, SDK configuration traps, project settings, and whether events are actually arriving. Use when analytics appears to be broken or a dashboard is unexpectedly empty.',
    inputSchema: {
      type: 'object',
      properties: {
        offline: { type: 'boolean', description: 'Skip the live ingest round-trip, which takes ~30s.' },
      },
    },
  },
  {
    name: 'get_event_definitions',
    description:
      'Event names PostHog has actually received, with when each was last seen. The difference between this and the tracking plan is where instrumentation has broken.',
    inputSchema: { type: 'object', properties: {} },
  },
]

export async function runMcp(argv: Argv): Promise<number> {
  const root = resolve(typeof argv.flags.cwd === 'string' ? argv.flags.cwd : process.cwd())
  const config = loadConfig(root)

  /** Connect lazily: tools that never touch PostHog must work without a key. */
  let clientPromise: Promise<{ client: PostHogClient; projectId: number }> | null = null
  const getClient = () => {
    if (!clientPromise) {
      clientPromise = (async () => {
        const region = config?.posthog.region ?? 'us'
        const { key, hosts } = await resolvePersonalKey({
          region,
          customHost: config?.posthog.host,
          envOnly: true,
        })
        const client = new PostHogClient({ personalApiKey: key, hosts })
        const projectId = config?.posthog.projectId ?? (await client.listProjects())[0]?.id
        if (!projectId) throw new Error('No PostHog project configured. Run `openhog init`.')
        return { client, projectId }
      })()
    }
    return clientPromise
  }

  const callTool = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    switch (name) {
      case 'explain_product': {
        const { client, projectId } = await getClient()
        const plan = loadPlan(root, config)
        let projectName = `Project ${projectId}`
        try {
          projectName = (await client.getProject(projectId)).name
        } catch {
          // project:read may be absent; the id is enough.
        }
        const set = await computeMetrics({
          client,
          projectId,
          projectName,
          productKind:
            (typeof args.kind === 'string' ? (args.kind as never) : undefined) ??
            plan?.product.kind ??
            config?.product.kind,
          roles: plan?.roles,
        })
        const findings = deriveFindings(set)
        return {
          score: healthScore(findings, set),
          headline: summarise(findings),
          context: set.context,
          findings,
          metrics: set.values,
        }
      }
      case 'propose_role_mapping': {
        const { client, projectId } = await getClient()
        const discovery = await discoverProject(client, projectId)
        const mapped = new Set(Object.keys(discovery.roles))
        return {
          instructions:
            'Map any role in `unmapped` that one of these events clearly plays, then call save_role_mapping. Leave a role out rather than guessing: an unmapped role removes the findings that need it, but a wrong one makes those findings lie. Also re-check anything in `guessedFromBehaviour` - those were inferred from how the event behaves, not from what it is called.',
          events: discovery.events.slice(0, 120).map((entry) => ({
            event: entry.event,
            people: entry.people,
            events: entry.events,
            perPerson: Number((entry.events / Math.max(1, entry.people)).toFixed(2)),
          })),
          currentMapping: discovery.roles,
          guessedFromBehaviour: discovery.inferredRoles,
          unmapped: ALL_ROLES.filter((role) => !mapped.has(role)).map((role) => ({
            role,
            means: ROLE_DESCRIPTIONS[role],
          })),
          savedTo: configPath(root),
        }
      }

      case 'save_role_mapping': {
        const input = (args.roles ?? {}) as Record<string, unknown>
        const roles: Record<string, string> = {}
        for (const [role, event] of Object.entries(input)) {
          if (typeof event === 'string' && event.trim()) roles[role] = event.trim()
        }
        if (!Object.keys(roles).length) return { error: 'No roles given.' }

        const existing = loadConfig(root)
        const next = {
          ...(existing ?? {
            version: 1 as const,
            posthog: {
              region: 'us' as const,
              host: 'https://us.posthog.com',
              ingestHost: 'https://us.i.posthog.com',
              assetHost: 'https://us-assets.i.posthog.com',
              publicKeyEnv: 'POSTHOG_KEY',
            },
            product: { kind: 'consumer' as const, packs: ['core'] },
          }),
          roles: { ...existing?.roles, ...roles },
        }
        saveConfig(root, next)
        return {
          saved: roles,
          savedTo: configPath(root),
          note: 'Every future `openhog explain` in this directory uses these. Re-run explain_product to see the report with them applied.',
        }
      }

      case 'preview_event_descriptions': {
        const { client, projectId } = await getClient()
        const [discovery, definitions] = await Promise.all([
          discoverProject(client, projectId),
          client.listEventDefinitions(projectId),
        ])
        const known = new Set(definitions.map((definition) => definition.name))
        const proposals = buildDescriptions({
          plan: loadPlan(root, config),
          roles: { ...discovery.roles, ...config?.roles },
          events: discovery.events,
          existing: new Map(definitions.map((d) => [d.name, d.description])),
          inferredRoles: discovery.inferredRoles,
        }).filter((proposal) => known.has(proposal.event))
        const { apply, keptExisting } = toApply(proposals)
        return {
          wouldWrite: apply.map((p) => ({
            event: p.event,
            description: p.description,
            basedOn: p.source,
          })),
          leftAloneBecauseAHumanWroteOne: keptExisting.map((p) => p.event),
          applyWith: 'openhog describe --write',
          note: 'Nothing has been written. That command previews by default, asks before writing, never replaces a description somebody wrote, and saves every previous value to openhog-describe-rollback.json first.',
        }
      }

      case 'get_tracking_plan': {
        const plan = loadPlan(root, config)
        if (!plan) return { error: 'No tracking plan. Run `openhog init` in this repository.' }
        const stage = typeof args.stage === 'string' ? args.stage : null
        const events = stage ? plan.events.filter((event) => event.stage === stage) : plan.events
        return {
          product: plan.product,
          stats: planStats(plan),
          roles: plan.roles,
          sensitiveRoutes: plan.identity.sensitiveRoutes,
          events: events.map((event) => ({
            name: event.name,
            description: event.description,
            stage: event.stage,
            emitted: event.emitted,
            sources: event.sources,
            properties: event.properties.map((property) => ({
              name: property.name,
              type: property.type,
              description: property.description,
            })),
          })),
        }
      }

      case 'query_analytics': {
        const query = String(args.query ?? '')
        if (!query.trim()) return { error: 'A query is required.' }
        const { client, projectId } = await getClient()
        const response = await client.query<{ results?: unknown[][]; columns?: string[] }>(projectId, {
          kind: 'HogQLQuery',
          query,
        })
        return {
          columns: response.columns ?? [],
          rows: response.results ?? [],
          rowCount: response.results?.length ?? 0,
          note:
            (response.results?.length ?? 0) === 100
              ? 'Exactly 100 rows came back, which is the API default limit. Add an explicit LIMIT if you need more.'
              : undefined,
        }
      }

      case 'list_dashboards': {
        const { client, projectId } = await getClient()
        const dashboards = await client.listDashboards(projectId)
        return dashboards
          .filter((dashboard) => !dashboard.deleted)
          .map((dashboard) => ({
            id: dashboard.id,
            name: dashboard.name,
            url: `${client.hosts.host}/project/${projectId}/dashboard/${dashboard.id}`,
          }))
      }

      case 'check_instrumentation_drift': {
        const plan = loadPlan(root, config)
        if (!plan) return { error: 'No tracking plan. Run `openhog init` first.' }
        return checkDrift({ plan, scan: scan(root, { ignore: config?.ignore }) })
      }

      case 'diagnose_analytics': {
        const plan = loadPlan(root, config)
        const scanned = scan(root, { ignore: config?.ignore })
        let client: PostHogClient | null = null
        let projectId: number | undefined
        let publicKey: string | undefined
        if (!args.offline) {
          try {
            const connection = await getClient()
            client = connection.client
            projectId = connection.projectId
            publicKey = (await connection.client.getProject(connection.projectId)).api_token
          } catch {
            // Static checks still run and are usually the ones that find it.
          }
        }
        const results = await runDoctor({
          root,
          config,
          plan,
          scan: scanned,
          client,
          projectId,
          publicKey,
          offline: Boolean(args.offline),
        })
        return {
          results,
          failing: results.filter((check) => check.status === 'fail').length,
          warnings: results.filter((check) => check.status === 'warn').length,
        }
      }

      case 'get_event_definitions': {
        const { client, projectId } = await getClient()
        return client.listEventDefinitions(projectId)
      }

      default:
        return { error: `Unknown tool: ${name}` }
    }
  }

  const send = (message: unknown): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`)
  }

  const reader = createInterface({ input: process.stdin })

  for await (const line of reader) {
    if (!line.trim()) continue
    let request: JsonRpcRequest
    try {
      request = JSON.parse(line) as JsonRpcRequest
    } catch {
      continue
    }

    // Notifications carry no id and must never be answered.
    const isNotification = request.id === undefined || request.id === null

    try {
      switch (request.method) {
        case 'initialize':
          send({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'openhog', version: '0.1.0' },
            },
          })
          break

        case 'tools/list':
          send({ jsonrpc: '2.0', id: request.id, result: { tools: TOOLS } })
          break

        case 'tools/call': {
          const params = (request.params ?? {}) as { name?: string; arguments?: Record<string, unknown> }
          const output = await callTool(params.name ?? '', params.arguments ?? {})
          send({
            jsonrpc: '2.0',
            id: request.id,
            result: { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] },
          })
          break
        }

        case 'ping':
          send({ jsonrpc: '2.0', id: request.id, result: {} })
          break

        default:
          if (!isNotification) {
            send({
              jsonrpc: '2.0',
              id: request.id,
              error: { code: -32601, message: `Method not found: ${request.method}` },
            })
          }
      }
    } catch (error) {
      if (!isNotification) {
        send({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        })
      }
    }
  }

  return 0
}
