/**
 * The MCP server, driven the way a real client drives it: newline-delimited
 * JSON-RPC over stdio, against the compiled binary.
 *
 * The protocol is implemented by hand to keep the package dependency-free, so
 * the framing rules are ours to get wrong — notably that a notification carries
 * no id and must never be answered.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeFixture, VITE_CONSUMER_APP, type Fixture } from './fixtures.js'
import { writeJson } from '../src/util/fs.js'
import { generatePlan } from '../src/plan/generate.js'
import { scan } from '../src/scan/index.js'

const CLI = join(process.cwd(), 'dist', 'cli.js')

/** Send a batch of messages, collect every response, then close stdin. */
async function talk(cwd: string, messages: unknown[]): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'mcp', '--cwd', cwd], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', POSTHOG_PERSONAL_API_KEY: '' },
    })
    let out = ''
    child.stdout.on('data', (chunk) => {
      out += String(chunk)
    })
    child.on('error', reject)
    child.on('close', () => {
      const parsed = out
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      resolve(parsed)
    })
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`)
    child.stdin.end()
    setTimeout(() => child.kill(), 25_000).unref?.()
  })
}

describe('the MCP server', () => {
  let fixture: Fixture

  beforeAll(() => {
    if (!existsSync(CLI)) throw new Error('Run `npm run build` before the MCP tests.')
    fixture = makeFixture(VITE_CONSUMER_APP)
    const scanned = scan(fixture.root)
    writeJson(join(fixture.root, 'openhog.config.json'), {
      version: 1,
      posthog: {
        region: 'us',
        host: 'https://us.posthog.com',
        ingestHost: 'https://us.i.posthog.com',
        assetHost: 'https://us-assets.i.posthog.com',
        publicKeyEnv: 'VITE_PUBLIC_POSTHOG_KEY',
      },
      product: { kind: 'consumer', packs: ['core', 'consumer'] },
    })
    writeJson(
      join(fixture.root, 'openhog', 'tracking-plan.json'),
      generatePlan({ scan: scanned, kind: 'consumer', packs: ['core', 'consumer'] }),
    )
  })

  afterAll(() => fixture.cleanup())

  it('completes the initialize handshake', async () => {
    const [response] = await talk(fixture.root, [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }])
    expect((response?.result as any)?.serverInfo?.name).toBe('openhog')
    expect((response?.result as any)?.capabilities?.tools).toBeDefined()
  }, 40_000)

  it('never answers a notification', async () => {
    // A response to a notification is a protocol violation and some clients
    // treat it as fatal.
    const responses = await talk(fixture.root, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: {} },
    ])
    expect(responses).toHaveLength(1)
    expect(responses[0]?.id).toBe(1)
  }, 40_000)

  it('lists tools with descriptions an agent can route on', async () => {
    const responses = await talk(fixture.root, [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }])
    const tools = (responses[0]?.result as any)?.tools as { name: string; description: string }[]
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['get_tracking_plan', 'query_analytics', 'check_instrumentation_drift']),
    )
    for (const tool of tools) expect(tool.description.length).toBeGreaterThan(40)
  }, 40_000)

  it('serves the tracking plan without needing any API key', async () => {
    const responses = await talk(fixture.root, [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_tracking_plan', arguments: {} } },
    ])
    const text = (responses[0]?.result as any)?.content?.[0]?.text as string
    const payload = JSON.parse(text)
    expect(payload.product.name).toBe('Lantern')
    expect(payload.events.some((event: { name: string }) => event.name === 'signup_completed')).toBe(true)
    expect(payload.roles.signup_completed).toBe('signup_completed')
  }, 40_000)

  it('checks drift offline', async () => {
    const responses = await talk(fixture.root, [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_instrumentation_drift', arguments: {} } },
    ])
    const payload = JSON.parse((responses[0]?.result as any)?.content?.[0]?.text as string)
    expect(payload.errors).toHaveLength(0)
    expect(payload.stats.emitted).toBeGreaterThan(5)
  }, 40_000)

  it('returns a JSON-RPC error for an unknown method rather than dying', async () => {
    const responses = await talk(fixture.root, [{ jsonrpc: '2.0', id: 9, method: 'nonsense/method' }])
    expect((responses[0]?.error as any)?.code).toBe(-32601)
  }, 40_000)

  it('survives a malformed line', async () => {
    const child = spawn(process.execPath, [CLI, 'mcp', '--cwd', fixture.root], { stdio: 'pipe' })
    let out = ''
    child.stdout.on('data', (chunk) => {
      out += String(chunk)
    })
    child.stdin.write('this is not json\n')
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })}\n`)
    child.stdin.end()
    await new Promise((resolve) => child.on('close', resolve))
    expect(out).toContain('"openhog"')
  }, 40_000)
})
