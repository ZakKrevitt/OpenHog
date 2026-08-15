/**
 * What counts as good.
 *
 * A number on its own is not actionable. "Week-1 retention is 22%" means
 * nothing until you know that it would be respectable for a consumer app and
 * alarming for a tool people pay for. That comparison is the thing most teams
 * do not have and cannot easily get, and supplying it is most of what makes a
 * dashboard useful rather than decorative.
 *
 * ## Where these numbers come from, honestly
 *
 * These are **rules of thumb**, not measurements. They come from widely
 * repeated industry guidance and from what the shape of a healthy product
 * usually looks like. They are not derived from a dataset of OpenHog users, and
 * they are not gospel: a niche B2B tool with fifty customers and a viral
 * consumer app can both be doing fine while sitting on opposite sides of every
 * band here.
 *
 * They are useful because they are approximately right and because the
 * alternative - no comparison at all - is what leaves teams staring at numbers
 * for a year without acting. Every finding that uses one says which band it
 * used and why, so you can disagree with it in an informed way.
 *
 * If you have better numbers for a vertical, that is a very welcome PR.
 */

import type { ProductKind } from '../types.js'

export type Band = 'poor' | 'fair' | 'good' | 'excellent'

export interface Benchmark {
  /** Ascending thresholds: below the first is `poor`, above the last `excellent`. */
  thresholds: [number, number, number]
  /** True when a lower number is better, so the bands invert. */
  lowerIsBetter?: boolean
  /** One line on why this range, shown in the report. */
  basis: string
}

type BenchmarkTable = Partial<Record<ProductKind | 'default', Benchmark>>

export const BENCHMARKS: Record<string, BenchmarkTable> = {
  retention_w1: {
    default: {
      thresholds: [0.15, 0.3, 0.45],
      basis: 'A product people return to unprompted keeps a meaningful share of a cohort past the first week.',
    },
    saas: {
      thresholds: [0.35, 0.55, 0.7],
      basis: 'Software people pay for should be part of a work routine within a week or it is not going to be.',
    },
    devtool: {
      thresholds: [0.25, 0.45, 0.6],
      basis: 'Developers who got a tool working once come back if it solved a recurring problem rather than a one-off.',
    },
    ecommerce: {
      thresholds: [0.08, 0.2, 0.35],
      basis: 'Purchase cycles are long; weekly return is not expected the way it is in a daily-use product.',
    },
    content: {
      thresholds: [0.1, 0.22, 0.35],
      basis: 'Most readers arrive from search or social for one piece. Return readership is the hard part.',
    },
  },

  retention_w4: {
    default: {
      thresholds: [0.08, 0.18, 0.3],
      basis: 'Week 4 is where a retention curve either flattens into a real product or decays to nothing.',
    },
    saas: {
      thresholds: [0.25, 0.42, 0.6],
      basis: 'A paying account that is inactive at week 4 is revenue you are about to lose, whatever billing says.',
    },
  },

  stickiness: {
    default: {
      thresholds: [0.08, 0.16, 0.3],
      basis: 'DAU/MAU is roughly the share of days a typical person shows up. 0.2 is a habit; 0.05 is occasional use.',
    },
    saas: {
      thresholds: [0.1, 0.22, 0.4],
      basis: 'A work tool used on most working days lands near 0.4; below 0.1 it is a monthly errand.',
    },
    content: {
      thresholds: [0.04, 0.1, 0.2],
      basis: 'Publications are read in bursts. Daily readership is rare and valuable.',
    },
  },

  activation_rate: {
    default: {
      thresholds: [0.3, 0.55, 0.75],
      basis: 'Of people who went to the trouble of signing up, most should reach the thing they signed up for.',
    },
  },

  signup_conversion: {
    default: {
      thresholds: [0.02, 0.06, 0.12],
      basis: 'Visit-to-signup varies enormously with traffic quality, so treat this as a very wide band.',
    },
    saas: {
      thresholds: [0.01, 0.04, 0.09],
      basis: 'B2B traffic includes a lot of research visits that were never going to convert.',
    },
  },

  purchase_conversion: {
    default: {
      thresholds: [0.02, 0.06, 0.12],
      basis: 'Share of engaged people who ever pay. Highly dependent on pricing model; a wide band.',
    },
  },

  power_user_share: {
    default: {
      thresholds: [0.05, 0.14, 0.25],
      basis: 'People active on 5+ days in a month. This group carries almost all the value in most products.',
    },
  },

  one_visit_share: {
    default: {
      thresholds: [0.5, 0.68, 0.82],
      lowerIsBetter: true,
      basis: 'Share of people whose entire history is one day. Usually far higher than teams expect.',
    },
  },

  error_exposure: {
    default: {
      thresholds: [0.02, 0.06, 0.12],
      lowerIsBetter: true,
      basis: 'Share of active people who saw something break. Above a few percent is a product-wide problem.',
    },
  },

  time_to_value: {
    default: {
      thresholds: [1, 3, 7],
      lowerIsBetter: true,
      basis: 'Median days from arriving to reaching value. The longer it takes, the more people never get there.',
    },
    devtool: {
      thresholds: [0.02, 0.2, 1],
      lowerIsBetter: true,
      basis: 'Developer tools are judged in the first ten minutes. Under an hour is the target.',
    },
  },

  channel_concentration: {
    default: {
      thresholds: [0.45, 0.65, 0.8],
      lowerIsBetter: true,
      basis: 'Share from the single largest channel. High concentration is fragile, not efficient.',
    },
  },
}

export interface BenchmarkResult {
  band: Band
  benchmark: Benchmark
  /** Human phrase, e.g. "well below typical for a consumer product". */
  comparison: string
}

const BAND_ORDER: Band[] = ['poor', 'fair', 'good', 'excellent']

export function bandFor(metricId: string, value: number, kind: ProductKind): BenchmarkResult | null {
  const table = BENCHMARKS[metricId]
  if (!table) return null
  const benchmark = table[kind] ?? table.default
  if (!benchmark) return null

  const [low, mid, high] = benchmark.thresholds
  let index: number
  if (benchmark.lowerIsBetter) {
    index = value <= low ? 3 : value <= mid ? 2 : value <= high ? 1 : 0
  } else {
    index = value < low ? 0 : value < mid ? 1 : value < high ? 2 : 3
  }
  const band = BAND_ORDER[index]!

  const kindLabel = KIND_LABELS[kind]
  const comparison =
    band === 'poor'
      ? `well below what is typical for ${kindLabel}`
      : band === 'fair'
        ? `on the low side of typical for ${kindLabel}`
        : band === 'good'
          ? `healthy for ${kindLabel}`
          : `strong for ${kindLabel}`

  return { band, benchmark, comparison }
}

export const KIND_LABELS: Record<ProductKind, string> = {
  saas: 'a paid software product',
  consumer: 'a consumer app',
  marketplace: 'a marketplace',
  ecommerce: 'an online store',
  'ai-app': 'an AI product',
  devtool: 'a developer tool',
  content: 'a publication',
}

/** The typical range as a readable string, for showing next to the value. */
export function typicalRange(metricId: string, kind: ProductKind): string | null {
  const table = BENCHMARKS[metricId]
  const benchmark = table?.[kind] ?? table?.default
  if (!benchmark) return null
  const [low, , high] = benchmark.thresholds
  const format = (value: number) =>
    metricId === 'time_to_value'
      ? value < 1
        ? `${Math.round(value * 24)}h`
        : `${value}d`
      : metricId === 'stickiness'
        ? value.toFixed(2)
        : `${Math.round(value * 100)}%`
  return benchmark.lowerIsBetter ? `under ${format(high)}` : `${format(low)} to ${format(high)}`
}
