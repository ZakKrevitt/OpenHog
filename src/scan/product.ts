/**
 * What is this product?
 *
 * The answer decides the pack, the event vocabulary and every dashboard name,
 * so it is drawn from the places a human would look first: the README's opening
 * claim, the package description, the landing page's title and hero. Each source
 * is kept as evidence rather than merged, because the LLM enrichment step reads
 * far better from four short verbatim quotes than from one averaged sentence.
 */

import { join, basename } from 'node:path'
import type { ProductKind, ScanResult } from '../types.js'
import { readIfSmall, readJson } from '../util/fs.js'

interface PackageJson {
  name?: string
  description?: string
  homepage?: string
}

const BADGE = /!?\[[^\]]*\]\([^)]*\)/g
const HTML_COMMENT = /<!--[\s\S]*?-->/g
const HTML_TAG = /<[^>]+>/g
const MD_EMPHASIS = /[*_`]+/g

function cleanProse(text: string): string {
  return text
    .replace(HTML_COMMENT, ' ')
    .replace(BADGE, ' ')
    .replace(HTML_TAG, ' ')
    .replace(MD_EMPHASIS, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The first real sentence of a README: its title line and its first paragraph. */
export function readReadme(root: string, files: string[]): { title?: string; summary?: string } {
  const candidate =
    files.find((file) => /^readme\.(md|markdown|rst|txt)$/i.test(basename(file)) && file.startsWith(root)) ??
    join(root, 'README.md')
  const raw = readIfSmall(candidate)
  if (!raw) return {}

  const lines = raw.split('\n')
  let title: string | undefined
  const paragraph: string[] = []
  let seenTitle = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (!seenTitle) {
      const heading = trimmed.match(/^#\s+(.*)$/)
      if (heading) {
        title = cleanProse(heading[1] ?? '')
        seenTitle = true
        continue
      }
      // Some READMEs lead with a centred logo block before the H1.
      if (!trimmed || trimmed.startsWith('<') || trimmed.startsWith('[!')) continue
      continue
    }
    if (/^#{1,6}\s/.test(trimmed)) break
    if (!trimmed) {
      if (paragraph.length) break
      continue
    }
    if (/^[-*>|]/.test(trimmed) || /^\d+\./.test(trimmed)) {
      if (paragraph.length) break
      continue
    }
    const cleaned = cleanProse(trimmed)
    if (cleaned) paragraph.push(cleaned)
    if (paragraph.join(' ').length > 400) break
  }

  const summary = cleanProse(paragraph.join(' ')) || undefined
  return { title, summary }
}

/** `<title>` and `<meta name="description">` from any index.html in the repo. */
export function readHtmlMeta(files: string[]): { title?: string; description?: string; url?: string } {
  const htmlFiles = files.filter((file) => /(^|\/)(index|app)\.html$/.test(file)).slice(0, 5)
  for (const file of htmlFiles) {
    const raw = readIfSmall(file)
    if (!raw) continue
    const title = raw.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]
    const description =
      raw.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i)?.[1] ??
      raw.match(/<meta[^>]+content=["']([^"']+)["'][^>]*name=["']description["']/i)?.[1]
    const url = raw.match(/<meta[^>]+property=["']og:url["'][^>]*content=["']([^"']+)["']/i)?.[1]
    if (title || description) {
      return {
        title: title ? cleanProse(title) : undefined,
        description: description ? cleanProse(description) : undefined,
        url,
      }
    }
  }
  return {}
}

/**
 * The largest heading on whatever looks like a landing page. This is the
 * product's own pitch in its own words, which beats any inference we could make
 * from the dependency tree.
 */
export function readHeroCopy(files: string[]): string[] {
  const landingish = files
    .filter((file) =>
      /(landing|marketing|home|hero|index|page|welcome|splash)/i.test(basename(file)) &&
      /\.(tsx|jsx|vue|svelte|astro|html)$/.test(file),
    )
    .slice(0, 25)

  const found: string[] = []
  for (const file of landingish) {
    const raw = readIfSmall(file)
    if (!raw) continue
    for (const match of raw.matchAll(/<h1[^>]*>([\s\S]{3,220}?)<\/h1>/gi)) {
      const text = cleanProse(match[1] ?? '')
      // JSX headings are full of `{t('key')}` and component calls; those carry
      // no product meaning and would poison the LLM prompt.
      if (text && !text.includes('{') && text.length > 8 && /[a-z]/i.test(text)) found.push(text)
    }
    if (found.length >= 4) break
  }
  return [...new Set(found)].slice(0, 4)
}

/**
 * Titles and blurbs that every scaffolded project ships with. If one of these
 * is still in the README, nobody has written a description yet and the HTML
 * title or package description is a better source.
 */
const SCAFFOLD_TITLES = [
  /^react \+ typescript \+ vite$/i,
  /^(vite|react|vue|svelte|next\.?js|nuxt|astro|solid|remix)( \+ \w+)*( app| template| starter| boilerplate)?$/i,
  /^create[- ]react[- ]app/i,
  /^getting started with create react app/i,
  /^welcome to (next\.?js|nuxt|remix|astro|svelte)/i,
  /^my[- ]app$/i,
  /^(app|project|website|frontend|backend|client|server|web|monorepo)$/i,
  /^this (template|project) provides/i,
  /^a (basic|minimal|simple) (template|starter|setup)/i,
  /^untitled/i,
]

export function isScaffoldTitle(value: string | undefined): boolean {
  if (!value) return false
  const trimmed = value.trim()
  if (trimmed.length < 3) return true
  return SCAFFOLD_TITLES.some((pattern) => pattern.test(trimmed))
}

export interface ProductProfile {
  name: string
  description: string
  url?: string
  evidence: string[]
}

export function buildProductProfile(root: string, files: string[]): ProductProfile {
  const pkg = readJson<PackageJson>(join(root, 'package.json'))
  const readme = readReadme(root, files)
  const meta = readHtmlMeta(files)
  const hero = readHeroCopy(files)

  const evidence: string[] = []
  if (readme.title && !isScaffoldTitle(readme.title)) evidence.push(`README title: ${readme.title}`)
  if (readme.summary && !isScaffoldTitle(readme.summary)) evidence.push(`README summary: ${readme.summary}`)
  if (pkg?.description) evidence.push(`package.json description: ${pkg.description}`)
  if (meta.title) evidence.push(`HTML title: ${meta.title}`)
  if (meta.description) evidence.push(`HTML meta description: ${meta.description}`)
  for (const line of hero) evidence.push(`Landing headline: ${line}`)

  // A README that still says "React + TypeScript + Vite" is the generator's
  // README, not the product's. Naming the product after the scaffold is the
  // single most visible way to look like a tool that did not actually read
  // anything, so known template titles are rejected outright.
  const readmeTitle = isScaffoldTitle(readme.title) ? undefined : readme.title
  const readmeSummary = isScaffoldTitle(readme.summary) ? undefined : readme.summary

  const name =
    readmeTitle ??
    // Splits "Lantern | live music" and its dash-separated variants. The dash
    // characters are written as unicode escapes and the plain hyphen is last in
    // the class, so this can never be read as a character range no matter what a
    // find-and-replace over the source does to literal dashes.
    meta.title?.split(/\s[|\u2013\u2014-]\s/)[0]?.trim() ??
    pkg?.name?.replace(/^@[^/]+\//, '') ??
    basename(root)

  const description =
    readmeSummary ??
    meta.description ??
    pkg?.description ??
    hero[0] ??
    'No product description found in the repository.'

  const url = pkg?.homepage ?? meta.url

  return { name: name.slice(0, 120), description: description.slice(0, 600), url, evidence }
}

// ---------------------------------------------------------------------------
// Product kind
// ---------------------------------------------------------------------------

/**
 * Score each kind against the signals rather than returning on the first match,
 * so a marketplace that also has subscriptions still reads as a marketplace.
 * The scores are deliberately visible in the result: `openhog init` prints its
 * reasoning and lets the answer be overridden, because this guess is wrong often
 * enough that hiding it would be dishonest.
 */
export function guessProductKind(
  signals: ScanResult['signals'],
  text: string,
): { kind: ProductKind; scores: Record<ProductKind, number>; reasons: string[] } {
  const haystack = text.toLowerCase()
  const has = (...words: string[]) => words.some((word) => haystack.includes(word))
  const reasons: string[] = []

  const scores: Record<ProductKind, number> = {
    saas: 0,
    consumer: 0,
    marketplace: 0,
    ecommerce: 0,
    'ai-app': 0,
    devtool: 0,
    content: 0,
  }

  if (signals.hasSubscriptions) {
    scores.saas += 3
    reasons.push('subscription or billing code found → saas')
  }
  if (signals.hasAuth && signals.hasOnboarding) {
    scores.saas += 2
    scores.consumer += 1
    reasons.push('auth plus an onboarding flow → saas or consumer')
  }
  if (signals.hasMarketplace) {
    scores.marketplace += 4
    reasons.push('listing, seller or booking vocabulary → marketplace')
  }
  if (signals.hasPayments && !signals.hasSubscriptions) {
    // A payment provider on its own says very little: SaaS, marketplaces and
    // stores all use Stripe. Only commerce vocabulary makes it a store.
    const commerceWords = has('cart', 'checkout', 'shipping', 'order', 'store', 'shop', 'sku', 'inventory')
    scores.ecommerce += commerceWords ? 3 : 1
    scores.marketplace += 1
    if (commerceWords) reasons.push('payments plus cart and order vocabulary → ecommerce')
  }
  if (signals.hasLlm) {
    scores['ai-app'] += 4
    reasons.push('an LLM SDK is a dependency → ai-app')
  }
  if (signals.hasChat) {
    scores['ai-app'] += 1
    scores.consumer += 1
  }
  if (signals.hasBlog && !signals.hasAuth) {
    scores.content += 4
    reasons.push('content routes without auth → content')
  } else if (signals.hasBlog) {
    scores.content += 1
  }
  if (has('cli', 'sdk', 'developer', 'api key', 'npm install', 'open source', 'terminal')) {
    scores.devtool += 3
    reasons.push('developer-facing vocabulary → devtool')
  }
  if (has('cart', 'checkout', 'product', 'shipping', 'order', 'store', 'shop')) {
    scores.ecommerce += 2
    reasons.push('commerce vocabulary in the product description → ecommerce')
  }
  if (has('marketplace', 'listing', 'seller', 'buyer', 'host', 'vendor', 'booking')) {
    scores.marketplace += 2
  }
  if (has('team', 'workspace', 'organisation', 'organization', 'seat', 'dashboard', 'b2b')) {
    scores.saas += 2
    reasons.push('team or workspace vocabulary → saas')
  }
  if (has('app', 'social', 'friends', 'feed', 'discover', 'community', 'profile')) {
    scores.consumer += 2
    reasons.push('social or feed vocabulary → consumer')
  }
  if (signals.hasSharing && signals.hasNotifications) {
    scores.consumer += 2
    reasons.push('sharing plus notifications → consumer')
  }

  let kind: ProductKind = 'saas'
  let best = -1
  for (const [candidate, score] of Object.entries(scores) as [ProductKind, number][]) {
    if (score > best) {
      best = score
      kind = candidate
    }
  }
  if (best <= 0) {
    kind = 'saas'
    reasons.push('no strong signal; defaulting to saas')
  }

  // B2B software essentially always talks about teams, workspaces or seats
  // somewhere. Without that vocabulary, a "saas" verdict that only narrowly beat
  // "consumer" is usually a consumer product with a payment provider in it -
  // and picking saas there gives it trial-conversion dashboards it can never
  // fill instead of the viral-loop ones it needs.
  const hasTeamVocabulary = has('team', 'workspace', 'organisation', 'organization', 'seat', 'tenant', 'b2b')
  if (kind === 'saas' && !hasTeamVocabulary && scores.saas - scores.consumer <= 2 && scores.consumer > 0) {
    kind = 'consumer'
    reasons.push('no team, workspace or seat vocabulary anywhere → consumer rather than saas')
  }

  return { kind, scores, reasons }
}
