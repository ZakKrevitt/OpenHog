/**
 * Fixture repositories, built on disk in a temp directory.
 *
 * The scanner's whole job is reading a real filesystem, so testing it against
 * an in-memory abstraction would prove nothing about the thing that actually
 * ships. These are small but real: real package.json, real route layout, real
 * call sites.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeText } from '../src/util/fs.js'

export interface Fixture {
  root: string
  cleanup: () => void
}

export function makeFixture(files: Record<string, string>): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'openhog-test-'))
  for (const [path, content] of Object.entries(files)) {
    writeText(join(root, path), content)
  }
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

/** A Vite + React consumer app with its own analytics vocabulary. */
export const VITE_CONSUMER_APP: Record<string, string> = {
  'package.json': JSON.stringify(
    {
      name: 'lantern',
      description: 'Find live music near you',
      dependencies: {
        react: '^18.0.0',
        'react-router-dom': '^6.0.0',
        posthog: '^1.0.0',
        'react-dropzone': '^14.0.0',
      },
      devDependencies: { vite: '^5.0.0', typescript: '^5.0.0' },
    },
    null,
    2,
  ),
  'README.md': '# Lantern\n\nLantern helps you find live music near you, tonight.\n\n## Install\n\nnpm install\n',
  'index.html':
    '<html><head><title>Lantern — live music near you</title><meta name="description" content="Find gigs tonight"></head><body></body></html>',
  'src/main.tsx': 'import "./app"\n',
  'src/analytics.ts': `
export const ANALYTICS_EVENT_NAMES = [
  'signup_completed',
  'gig_detail_opened',
  'save_clicked',
  'share_clicked',
  'search_submit',
  'invite_shared',
  'invite_accepted',
  'follow_changed',
  'error_shown',
  'page_viewed',
] as const
`,
  'src/routes.tsx': `
export const routes = [
  { path: '/' },
  { path: '/gigs/:id' },
  { path: '/artists/:slug' },
  { path: '/settings' },
  { path: '/messages/:threadId' },
  { path: '/signup' },
]
`,
  'src/pages/SettingsPage.tsx': 'export function SettingsPage() { return null }\n',
  'src/pages/SettingsPage.test.tsx': 'it("renders", () => {})\n',
  'src/components/Save.tsx': `
import { trackEvent } from '../analytics'
export function Save() {
  return <button onClick={() => trackEvent('save_clicked', { surface: 'gig' })}>Save</button>
}
`,
  'src/lib/auth.ts': 'export function signIn() {}\nexport function signOut() {}\nexport const currentUser = null\n',
  'src/lib/session.ts': 'export function useSession() {}\nexport function requireAuth() {}\nexport const isAuthenticated = false\n',
  'src/components/SignUpForm.tsx': 'import { signUp } from "../lib/auth"\nexport const Form = () => signUp()\n',
  'src/lib/upload.ts': 'export async function uploadFile(f: File) { const body = new FormData(); return body }\n',
  'src/lib/share.ts': 'export const shareUrl = (id: string) => navigator.share({ url: id })\nexport const shareLink = "x"\n',
  'src/components/ShareButton.tsx': 'export const ShareButton = () => copyToClipboard(shareLink)\n',
  'src/lib/referral.ts': 'export const referral = { code: "abc" }\nexport const shareUrl = "/r/abc"\n',
  '.gitignore': 'node_modules\n.env\n.env.local\n',
  'vercel.json': JSON.stringify(
    {
      headers: [
        {
          source: '/(.*)',
          headers: [
            {
              key: 'Content-Security-Policy',
              value:
                "default-src 'self'; script-src 'self'; connect-src 'self' https://us.i.posthog.com",
            },
          ],
        },
      ],
    },
    null,
    2,
  ),
}

/** A Next.js app-router SaaS, with a genuine file-based router. */
export const NEXT_SAAS_APP: Record<string, string> = {
  'package.json': JSON.stringify(
    {
      name: 'ledgerly',
      description: 'Team expense tracking',
      dependencies: { next: '^15.0.0', react: '^19.0.0', stripe: '^17.0.0' },
    },
    null,
    2,
  ),
  'README.md': '# Ledgerly\n\nTeam expense tracking for growing organizations. Seats, workspaces, the lot.\n',
  'app/layout.tsx': 'export default function Layout() { return null }\n',
  'app/page.tsx': 'export default function Home() { return null }\n',
  'app/dashboard/page.tsx': 'export default function Dashboard() { return null }\n',
  'app/expenses/[id]/page.tsx': 'export default function Expense() { return null }\n',
  'app/settings/billing/page.tsx': 'export default function Billing() { return null }\n',
  'app/pricing/page.tsx': 'export default function Pricing() { return null }\n',
  'lib/billing.ts': `
export const subscription = { price_id: 'x', plan_id: 'y', trial_end: 0, seats: 3 }
export function billingPortal() {}
export const recurring = true
`,
  'lib/seats.ts': 'export const seats = 5\nexport const workspace = { id: 1 }\nexport const subscription = null\n',
  'app/api/webhooks/stripe/route.ts': `
export async function POST() {
  const subscription = { plan_id: 'pro', trial_end: 0, recurring: true }
  return Response.json(subscription)
}
`,
  'components/SeatPicker.tsx': 'export const SeatPicker = () => null // seats per workspace for the team subscription\n',
  'lib/track.ts': `
import posthog from 'posthog-js'
export function report() {
  posthog.capture('subscription_started', { plan: 'pro' })
  posthog.capture('trial_started', {})
  posthog.capture('expense_created', {})
  posthog.capture('pricing_viewed', {})
  posthog.capture('signup_completed', {})
  posthog.capture('team_invite_sent', {})
}
`,
}

/** A repo with no analytics at all — the cold-start case. */
export const BARE_APP: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'my-app', dependencies: { react: '^18.0.0' } }, null, 2),
  'README.md': '# React + TypeScript + Vite\n\nThis template provides a minimal setup.\n',
  'src/main.tsx': 'console.log("hello")\n',
}
