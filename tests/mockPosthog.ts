/**
 * A real HTTP server that speaks enough of the PostHog API to exercise the
 * client, the sync engine and the doctor end to end.
 *
 * Real HTTP rather than a stubbed fetch, because the things most likely to be
 * wrong are header handling, status-code branching, retry behaviour and JSON
 * framing - none of which a stub would catch.
 */

import { createServer, type Server } from 'node:http'

export interface MockState {
  requests: { method: string; path: string; body: unknown; auth?: string }[]
  dashboards: { id: number; name: string; description: string; deleted: boolean; tiles: unknown[] }[]
  insights: { id: number; name: string; query: unknown; dashboards: number[] }[]
  /** Queries that should fail, to exercise tile validation. */
  failQueriesMatching?: RegExp
  /**
   * Canned HogQL answers, matched in order against the query text. Lets a test
   * drive the whole metrics and findings pipeline with a realistic project
   * shape instead of one magic number for every question.
   */
  hogql?: { match: RegExp; rows: unknown[][]; columns?: string[] }[]
  /** Respond 429 this many times before succeeding. */
  rateLimitTimes?: number
  /** Force a scope failure on this path fragment. */
  forbidPath?: string
  /** Event definitions the project has, keyed by name. */
  eventDefinitions?: { id: string; name: string; description?: string | null; tags?: string[] }[]
  /** Accept the PATCH but do not persist it, the worst failure mode. */
  swallowDefinitionWrites?: boolean
}

export interface MockServer {
  url: string
  state: MockState
  close: () => Promise<void>
}

export async function startMockPostHog(initial: Partial<MockState> = {}): Promise<MockServer> {
  const state: MockState = {
    requests: [],
    dashboards: [],
    insights: [],
    ...initial,
  }

  let nextId = 1000
  let rateLimited = 0

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: unknown = undefined
      try {
        body = raw ? JSON.parse(raw) : undefined
      } catch {
        body = raw
      }
      const path = (req.url ?? '').split('?')[0] ?? ''
      state.requests.push({
        method: req.method ?? 'GET',
        path,
        body,
        auth: req.headers.authorization,
      })

      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(payload))
      }

      if (!req.headers.authorization?.startsWith('Bearer ')) {
        return json(401, { detail: 'Authentication credentials were not provided.' })
      }
      if (state.forbidPath && path.includes(state.forbidPath)) {
        return json(403, { detail: 'Insufficient scope' })
      }
      if (state.rateLimitTimes && rateLimited < state.rateLimitTimes) {
        rateLimited += 1
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' })
        return res.end(JSON.stringify({ detail: 'Rate limit exceeded' }))
      }

      // --- projects ---
      if (path === '/api/projects/' && req.method === 'GET') {
        return json(200, {
          results: [{ id: 1, name: 'Test project', api_token: 'phc_test_token', timezone: 'Europe/Berlin', week_start_day: 1 }],
        })
      }
      if (/^\/api\/projects\/\d+\/$/.test(path) && req.method === 'GET') {
        return json(200, {
          id: 1,
          name: 'Test project',
          api_token: 'phc_test_token',
          timezone: 'Europe/Berlin',
          week_start_day: 1,
        })
      }

      // --- dashboards ---
      if (path.endsWith('/dashboards/') && req.method === 'GET') {
        return json(200, { results: state.dashboards })
      }
      if (path.endsWith('/dashboards/') && req.method === 'POST') {
        const input = body as { name: string; description?: string }
        const dashboard = {
          id: (nextId += 1),
          name: input.name,
          description: input.description ?? '',
          deleted: false,
          tiles: [] as unknown[],
        }
        state.dashboards.push(dashboard)
        return json(201, dashboard)
      }
      const dashboardMatch = path.match(/^\/api\/projects\/\d+\/dashboards\/(\d+)\/$/)
      if (dashboardMatch) {
        const id = Number(dashboardMatch[1])
        const dashboard = state.dashboards.find((candidate) => candidate.id === id)
        if (!dashboard) return json(404, { detail: 'Not found' })
        if (req.method === 'GET') {
          const tiles = state.insights
            .filter((insight) => insight.dashboards.includes(id))
            .map((insight, index) => ({ id: 5000 + index, insight: { id: insight.id, name: insight.name } }))
          return json(200, { ...dashboard, tiles })
        }
        if (req.method === 'PATCH') {
          const patch = body as { deleted?: boolean; tiles?: unknown[] }
          if (patch.deleted) dashboard.deleted = true
          if (patch.tiles) dashboard.tiles = patch.tiles
          return json(200, dashboard)
        }
      }

      // --- insights ---
      if (path.endsWith('/insights/') && req.method === 'POST') {
        const input = body as { name: string; query: unknown; dashboards?: number[] }
        const insight = {
          id: (nextId += 1),
          short_id: `s${nextId}`,
          name: input.name,
          query: input.query,
          dashboards: input.dashboards ?? [],
        }
        state.insights.push(insight)
        return json(201, insight)
      }

      // --- query ---
      if (path.endsWith('/query/') && req.method === 'POST') {
        const input = body as { query?: { query?: string; kind?: string } }
        const text = JSON.stringify(input.query ?? {})
        if (state.failQueriesMatching?.test(text)) {
          return json(400, { detail: 'Unsupported function in HogQL query' })
        }
        const sql = input.query?.query ?? ''
        for (const canned of state.hogql ?? []) {
          if (canned.match.test(sql)) {
            return json(200, { results: canned.rows, columns: canned.columns ?? [] })
          }
        }
        return json(200, { results: [[42]], columns: ['count'] })
      }

      // --- event definitions ---
      if (path.endsWith('/event_definitions/')) {
        const defs = state.eventDefinitions ?? [
          { id: 'def-1', name: 'signup_completed', description: null, tags: [] },
        ]
        return json(200, { results: defs, next: null })
      }
      const defMatch = path.match(/^\/api\/projects\/\d+\/event_definitions\/([\w-]+)\/$/)
      if (defMatch) {
        const defs = state.eventDefinitions ?? []
        const def = defs.find((candidate) => candidate.id === defMatch[1])
        if (!def) return json(404, { detail: 'Not found' })
        if (req.method === 'PATCH') {
          const patch = body as { description?: string; tags?: string[] }
          if (!state.swallowDefinitionWrites) {
            if (patch.description !== undefined) def.description = patch.description
            if (patch.tags) def.tags = patch.tags
          }
          return json(200, def)
        }
        return json(200, def)
      }

      // --- ingest ---
      if (path === '/i/v0/e/' || path === '/batch/') {
        return json(200, { status: 1 })
      }

      return json(404, { detail: `No mock route for ${req.method} ${path}` })
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
