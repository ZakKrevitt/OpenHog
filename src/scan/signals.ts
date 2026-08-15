/**
 * Feature signals.
 *
 * Each signal answers one question: does this product DO this thing? They drive
 * the product-kind guess and, more usefully, decide which events are worth
 * suggesting. There is no point proposing `checkout_started` to a repo with no
 * payment code in it.
 */

import type { ScanResult } from '../types.js'
import { readIfSmall } from '../util/fs.js'

type SignalKey = keyof ScanResult['signals']

/**
 * Dependency names are near-zero false positive; source patterns are noisier,
 * so a signal needs either one dependency hit or `minHits` distinct source hits.
 *
 * `minHits` exists because some vocabularies are generic enough to appear in
 * any codebase. "listing", "supply" and "host" turned a nightlife app into a
 * marketplace, which then picked the wrong dashboard pack — so the signals with
 * broad wording need real weight of evidence, not two incidental mentions.
 */
const SIGNALS: Record<SignalKey, { deps: RegExp; source: RegExp; minHits?: number }> = {
  hasAuth: {
    deps: /next-auth|@auth\/|@clerk|@supabase\/auth|firebase\/auth|passport|lucia|@auth0|better-auth|@workos/,
    source: /\b(signIn|signOut|signUp|useSession|currentUser|isAuthenticated|requireAuth|login|logout)\b/,
  },
  hasPayments: {
    deps: /stripe|@stripe|braintree|paddle|lemonsqueezy|razorpay|@paypal|square/,
    source: /\b(checkout|createPaymentIntent|payment_intent|charge|paymentMethod)\b/i,
  },
  hasSubscriptions: {
    // Stripe alone does not mean subscriptions: one-off payments use it too, and
    // treating every Stripe repo as SaaS mis-picks the pack for every store.
    deps: /paddle|lemonsqueezy|revenuecat|@revenuecat/,
    source: /\b(subscription|billingPortal|price_id|plan_id|trial_end|seats?|recurring)\b/i,
    minHits: 3,
  },
  hasUploads: {
    deps: /multer|uppy|@uploadthing|filepond|react-dropzone|@aws-sdk\/client-s3|cloudinary/,
    source: /\b(uploadFile|FormData\(\)|multipart\/form-data|presignedUrl)\b/,
  },
  hasSearch: {
    deps: /algolia|meilisearch|typesense|elasticsearch|@orama|fuse\.js|flexsearch/,
    source: /\b(searchQuery|onSearch|searchTerm|\?q=|handleSearch)\b/,
  },
  hasChat: {
    deps: /socket\.io|pusher|ably|stream-chat|@sendbird|@liveblocks/,
    source: /\b(sendMessage|messages\.|conversationId|threadId|chatInput)\b/,
  },
  hasLlm: {
    deps: /openai|@anthropic-ai|@ai-sdk|langchain|llamaindex|@google\/generative-ai|groq-sdk|ollama|cohere/,
    source: /\b(chat\.completions|messages\.create|streamText|generateText|systemPrompt|gpt-4|claude-)\b/,
  },
  hasMarketplace: {
    deps: /$^/,
    // Deliberately strict: these words appear incidentally in almost any app.
    source: /\b(seller|sellers|vendor_id|buyer|marketplace|listing_id|listings|reservation|host_id)\b/i,
    minHits: 6,
  },
  hasBlog: {
    deps: /contentlayer|@nuxt\/content|gray-matter|@sanity|contentful|next-mdx/,
    source: /\b(blog|frontmatter|publishedAt|readingTime|excerpt)\b/i,
    minHits: 5,
  },
  hasEmail: {
    deps: /resend|@sendgrid|nodemailer|postmark|mailgun|@react-email|loops/,
    source: /\b(sendEmail|sendMail|emailTemplate|transactionalEmail)\b/,
  },
  hasWaitlist: {
    deps: /$^/,
    source: /\b(waitlist|waiting_list|early_?access|joinWaitlist|invite_code)\b/i,
  },
  hasOnboarding: {
    deps: /$^/,
    source: /\b(onboarding|getting_?started|setupWizard|firstRun|welcomeStep)\b/i,
    minHits: 3,
  },
  hasSharing: {
    deps: /react-share|@vercel\/og|satori/,
    source: /\b(navigator\.share|shareUrl|shareLink|copyToClipboard|og:image|referral)\b/,
  },
  hasNotifications: {
    deps: /web-push|@novu|onesignal|expo-notifications|firebase\/messaging|knock/,
    source: /\b(pushNotification|Notification\.requestPermission|notificationToken|subscribeToPush)\b/,
  },
}

export function detectSignals(files: string[], dependencyBlob: string): ScanResult['signals'] {
  const hits: Record<string, number> = {}
  const depsMatched: Record<string, boolean> = {}

  for (const [key, { deps }] of Object.entries(SIGNALS)) {
    depsMatched[key] = deps.source !== '$^' && deps.test(dependencyBlob)
  }

  // One pass over the sources, testing every source pattern per file, rather
  // than one pass per signal. Fourteen re-reads of a large repo is the
  // difference between a two-second scan and a thirty-second one.
  for (const file of files.slice(0, 6000)) {
    const content = readIfSmall(file, 200 * 1024)
    if (!content) continue
    for (const [key, { source }] of Object.entries(SIGNALS)) {
      if (source.test(content)) hits[key] = (hits[key] ?? 0) + 1
    }
  }

  const result = {} as ScanResult['signals']
  for (const key of Object.keys(SIGNALS) as SignalKey[]) {
    const threshold = SIGNALS[key].minHits ?? 2
    result[key] = Boolean(depsMatched[key]) || (hits[key] ?? 0) >= threshold
  }
  return result
}
