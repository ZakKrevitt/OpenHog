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
import { loadConfig, loadPlan } from '../config.js'
import { runDoctor } from '../doctor/index.js'
import { PostHogClient, hostsForRegion } from '../posthog/client.js'
import { resolvePersonalKey } from '../posthog/auth.js'
import { planStats } from '../plan/generate.js'
import { computeMetrics } from '../metrics/compute.js'
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
