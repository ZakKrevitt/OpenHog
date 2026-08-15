/**
 * The pack registry.
 *
 * Adding a pack is one file plus one line here. That is deliberate: packs are
 * the part of OpenHog that benefits most from people who know a vertical better
 * than we do, and a contribution that needs changes in four places does not get
 * made. See docs/PACKS.md.
 */

import type { Pack, ProductKind } from '../types.js'
import { corePack } from './core.js'
import { saasPack } from './saas.js'
import { consumerPack } from './consumer.js'
import { marketplacePack } from './marketplace.js'
import { ecommercePack } from './ecommerce.js'
import { aiAppPack } from './ai-app.js'
import { devtoolPack } from './devtool.js'
import { contentPack } from './content.js'

export const PACKS: Pack[] = [
  corePack,
  saasPack,
  consumerPack,
  marketplacePack,
  ecommercePack,
  aiAppPack,
  devtoolPack,
  contentPack,
]

export function packById(id: string): Pack | undefined {
  return PACKS.find((pack) => pack.id === id)
}

/** Core always applies; the kind pack is added on top. */
export function packsForKind(kind: ProductKind): Pack[] {
  return PACKS.filter((pack) => pack.appliesTo.includes(kind))
}

export function resolvePacks(ids: string[]): Pack[] {
  return ids.map(packById).filter((pack): pack is Pack => Boolean(pack))
}

export {
  corePack,
  saasPack,
  consumerPack,
  marketplacePack,
  ecommercePack,
  aiAppPack,
  devtoolPack,
  contentPack,
}
export * from './helpers.js'
