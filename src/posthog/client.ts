/**
 * PostHog REST client.
 *
 * Three things this does that a bare `fetch` wrapper would not:
 *
 *   - Turns a 403 into the name of the missing personal-API-key scope. PostHog
 *     answers scope failures with a generic permission error, and "you need
 *     insight:write" is the difference between a 30-second fix and abandoning
 *     the tool.
 *   - Honours 429 `Retry-After`. Creating 60 insights in a loop is exactly the
 *     shape of request PostHog rate limits, and a half-built dashboard is worse
 *     than a slow one.
 *   - Never logs the key, including in error paths.
 */

import type { PostHogProject, PostHogQuery, PostHogRegion } from '../types.js'

export interface RegionHosts {
  /** The app and API host. */
  host: string
  /** Where events are POSTed. */
  ingestHost: string
  /** Where lazily-loaded bundles (the replay recorder, toolbar) come from. */
  assetHost: string
}

export const REGIONS: Record<Exclude<PostHogRegion, 'custom'>, RegionHosts> = {
  us: {
    host: 'https://us.posthog.com',
    ingestHost: 'https://us.i.posthog.com',
    assetHost: 'https://us-assets.i.posthog.com',
  },
  eu: {
    host: 'https://eu.posthog.com',
    ingestHost: 'https://eu.i.posthog.com',
    assetHost: 'https://eu-assets.i.posthog.com',
  },
}

/** Self-hosted deployments serve app, ingest and assets from one origin. */
export function customRegion(host: string): RegionHosts {
  const trimmed = host.replace(/\/+$/, '')
  return { host: trimmed, ingestHost: trimmed, assetHost: trimmed }
}

export function hostsForRegion(region: PostHogRegion, customHost?: string): RegionHosts {
  if (region === 'custom') {
    if (!customHost) throw new PostHogError('A custom region needs an explicit host.')
    return customRegion(customHost)
  }
  return REGIONS[region]
}

export class PostHogError extends Error {
  readonly status?: number
  readonly hint?: string

  constructor(message: string, options: { status?: number; hint?: string } = {}) {
    super(message)
    this.name = 'PostHogError'
    this.status = options.status
    this.hint = options.hint
  }
}

/** Which scope each endpoint needs, so a 403 can name it. */
const SCOPE_HINTS: [RegExp, string][] = [
  [/\/insights\//, 'insight:write'],
  [/\/dashboards\//, 'dashboard:write'],
  [/\/query\//, 'query:read'],
  [/\/projects\/?$/, 'project:read'],
  [/\/projects\/\d+\/?$/, 'project:read'],
  [/\/annotations\//, 'annotation:write'],
  [/\/event_definitions\//, 'event_definition:read'],
  [/\/property_definitions\//, 'property_definition:read'],
]

function scopeFor(path: string): string | undefined {
  return SCOPE_HINTS.find(([pattern]) => pattern.test(path))?.[1]
}

export interface ClientOptions {
  personalApiKey: string
  hosts: RegionHosts
  /** Injected in tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch
  maxRetries?: number
  /** Overridable so tests do not actually sleep. */
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export class PostHogClient {
  private readonly key: string
  private readonly fetchImpl: typeof fetch
  private readonly maxRetries: number
  private readonly sleep: (ms: number) => Promise<void>
  readonly hosts: RegionHosts

  constructor(options: ClientOptions) {
    this.key = options.personalApiKey
    this.hosts = options.hosts
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.maxRetries = options.maxRetries ?? 4
    this.sleep = options.sleep ?? defaultSleep
  }

  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown; query?: Record<string, string> } = {},
  ): Promise<T> {
    const url = new URL(path, this.hosts.host)
    for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value)

    let attempt = 0
    for (;;) {
      let response: Response
      try {
        response = await this.fetchImpl(url.toString(), {
          method: init.method ?? 'GET',
          headers: {
            Authorization: `Bearer ${this.key}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': 'openhog',
          },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
        })
      } catch (error) {
        if (attempt >= this.maxRetries) {
          throw new PostHogError(
            `Could not reach ${url.host}: ${(error as Error).message}`,
            { hint: 'Check the host and your network. Self-hosted? Pass --host.' },
          )
        }
        attempt += 1
        await this.sleep(250 * 2 ** attempt)
        continue
      }

      if (response.status === 429 && attempt < this.maxRetries) {
        const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10)
        const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000 * 2 ** attempt
        attempt += 1
        await this.sleep(Math.min(waitMs, 30_000))
        continue
      }

      // 5xx from PostHog is usually transient; a retried POST to /insights/ can
      // duplicate, so only idempotent reads are retried here.
      if (response.status >= 500 && attempt < this.maxRetries && (init.method ?? 'GET') === 'GET') {
        attempt += 1
        await this.sleep(500 * 2 ** attempt)
        continue
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw this.describeFailure(response.status, path, text)
      }

      if (response.status === 204) return undefined as T
      const text = await response.text()
      if (!text) return undefined as T
      try {
        return JSON.parse(text) as T
      } catch {
        throw new PostHogError(`PostHog returned a non-JSON body for ${path}.`, {
          status: response.status,
        })
      }
    }
  }

  private describeFailure(status: number, path: string, body: string): PostHogError {
    let detail = body.slice(0, 400)
    try {
      const parsed = JSON.parse(body) as { detail?: string; type?: string; code?: string }
      if (parsed.detail) detail = parsed.detail
    } catch {
      // Leave the raw body; it is already truncated.
    }

    if (status === 401) {
      return new PostHogError('PostHog rejected the personal API key.', {
        status,
        hint: 'The key is wrong, revoked, or from a different region. Run `openhog auth --reset`.',
      })
    }
    if (status === 403) {
      const scope = scopeFor(path)
      return new PostHogError(
        scope
          ? `The personal API key is missing the "${scope}" scope.`
          : `PostHog refused that request: ${detail}`,
        {
          status,
          hint: scope
            ? `Edit the key at ${this.hosts.host}/settings/user-api-keys and tick "${scope}".`
            : undefined,
        },
      )
    }
    if (status === 404) {
      return new PostHogError(`PostHog has no ${path}.`, {
        status,
        hint: 'Usually a project id from a different organisation or region.',
      })
    }
    return new PostHogError(`PostHog returned ${status} for ${path}: ${detail}`, { status })
  }

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------

  async listProjects(): Promise<PostHogProject[]> {
    const response = await this.request<{ results: PostHogProject[] }>('/api/projects/')
    return response.results ?? []
  }

  async getProject(projectId: number): Promise<PostHogProject> {
    return this.request<PostHogProject>(`/api/projects/${projectId}/`)
  }

  /**
   * Timezone and week-start are the two project settings that silently corrupt
   * every daily metric when they are wrong. A product whose evening is the
   * user's evening gets its nights split across two calendar days under UTC.
   */
  async updateProject(
    projectId: number,
    patch: { timezone?: string; week_start_day?: 0 | 1 },
  ): Promise<PostHogProject> {
    return this.request<PostHogProject>(`/api/projects/${projectId}/`, {
      method: 'PATCH',
      body: patch,
    })
  }

  // -------------------------------------------------------------------------
  // Dashboards and insights
  // -------------------------------------------------------------------------

  async createDashboard(
    projectId: number,
    dashboard: { name: string; description?: string; pinned?: boolean; tags?: string[] },
  ): Promise<{ id: number; name: string }> {
    return this.request(`/api/projects/${projectId}/dashboards/`, {
      method: 'POST',
      body: {
        name: dashboard.name,
        description: dashboard.description ?? '',
        pinned: dashboard.pinned ?? false,
        tags: dashboard.tags ?? [],
      },
    })
  }

  async listDashboards(projectId: number): Promise<{ id: number; name: string; deleted: boolean }[]> {
    const response = await this.request<{ results: { id: number; name: string; deleted: boolean }[] }>(
      `/api/projects/${projectId}/dashboards/`,
      { query: { limit: '200' } },
    )
    return response.results ?? []
  }

  async getDashboard(
    projectId: number,
    dashboardId: number,
  ): Promise<{ id: number; name: string; tiles: { id: number; insight?: { id: number; name: string } }[] }> {
    return this.request(`/api/projects/${projectId}/dashboards/${dashboardId}/`)
  }

  async deleteDashboard(projectId: number, dashboardId: number): Promise<void> {
    await this.request(`/api/projects/${projectId}/dashboards/${dashboardId}/`, {
      method: 'PATCH',
      body: { deleted: true },
    })
  }

  async createInsight(
    projectId: number,
    insight: {
      name: string
      description?: string
      query: PostHogQuery
      dashboards?: number[]
      tags?: string[]
      favorited?: boolean
    },
  ): Promise<{ id: number; short_id: string; name: string }> {
    return this.request(`/api/projects/${projectId}/insights/`, {
      method: 'POST',
      body: {
        name: insight.name,
        description: insight.description ?? '',
        query: insight.query,
        dashboards: insight.dashboards ?? [],
        tags: insight.tags ?? [],
        saved: true,
        favorited: insight.favorited ?? false,
      },
    })
  }

  /**
   * Tile geometry. PostHog's grid is 12 columns wide on `sm` and 1 on `xs`, and
   * a dashboard created without layouts stacks every tile full-width, which
   * makes a 12-tile dashboard a very long page nobody scrolls.
   */
  async setDashboardLayouts(
    projectId: number,
    dashboardId: number,
    tiles: { id: number; layouts: Record<string, unknown> }[],
  ): Promise<void> {
    await this.request(`/api/projects/${projectId}/dashboards/${dashboardId}/`, {
      method: 'PATCH',
      body: { tiles },
    })
  }

  // -------------------------------------------------------------------------
  // Querying
  // -------------------------------------------------------------------------

  /** Run a query now. Used by `openhog verify` to prove a tile returns rows. */
  async query<T = unknown>(projectId: number, query: PostHogQuery): Promise<T> {
    return this.request<T>(`/api/projects/${projectId}/query/`, {
      method: 'POST',
      body: { query },
    })
  }

  /**
   * Event names PostHog has actually seen. This is the other half of the
   * "no invented events" check: the plan says what the code emits, this says
   * what arrived, and the interesting set is the difference.
   */
  async listEventDefinitions(projectId: number): Promise<{ name: string; last_seen_at?: string }[]> {
    const response = await this.request<{ results: { name: string; last_seen_at?: string }[] }>(
      `/api/projects/${projectId}/event_definitions/`,
      { query: { limit: '500' } },
    )
    return response.results ?? []
  }

  async createAnnotation(
    projectId: number,
    annotation: { content: string; date_marker: string; scope?: 'project' | 'dashboard' },
  ): Promise<{ id: number }> {
    return this.request(`/api/projects/${projectId}/annotations/`, {
      method: 'POST',
      body: { ...annotation, scope: annotation.scope ?? 'project' },
    })
  }

  // -------------------------------------------------------------------------
  // Ingestion
  // -------------------------------------------------------------------------

  /**
   * Send an event through the public ingest endpoint, exactly as a browser
   * would. `openhog doctor` uses this to prove the pipeline end to end, and
   * `openhog demo` uses it to make an empty project look like a real one.
   */
  async capture(
    publicKey: string,
    event: { event: string; distinctId: string; properties?: Record<string, unknown>; timestamp?: string },
  ): Promise<void> {
    const response = await this.fetchImpl(`${this.hosts.ingestHost}/i/v0/e/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'openhog' },
      body: JSON.stringify({
        api_key: publicKey,
        event: event.event,
        distinct_id: event.distinctId,
        properties: { ...event.properties, $lib: 'openhog' },
        timestamp: event.timestamp ?? new Date().toISOString(),
      }),
    })
    if (!response.ok) {
      throw new PostHogError(`Ingest rejected the event (${response.status}).`, {
        status: response.status,
        hint: 'Usually a wrong public key (phc_...) or the wrong region host.',
      })
    }
  }

  /** Batch ingest. The demo seeder sends thousands of events. */
  async captureBatch(
    publicKey: string,
    events: { event: string; distinctId: string; properties?: Record<string, unknown>; timestamp: string }[],
  ): Promise<void> {
    const response = await this.fetchImpl(`${this.hosts.ingestHost}/batch/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'openhog' },
      body: JSON.stringify({
        api_key: publicKey,
        batch: events.map((event) => ({
          event: event.event,
          distinct_id: event.distinctId,
          properties: { ...event.properties, $lib: 'openhog' },
          timestamp: event.timestamp,
        })),
      }),
    })
    if (!response.ok) {
      throw new PostHogError(`Batch ingest rejected ${events.length} events (${response.status}).`, {
        status: response.status,
      })
    }
  }
}
