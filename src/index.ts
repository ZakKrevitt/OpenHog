/**
 * Library entry point.
 *
 * Everything the CLI does is available programmatically, because the most
 * common serious use of a tool like this is inside somebody else's deploy
 * script or internal platform, not at a prompt.
 */

export * from './types.js'
export { scan, productContext } from './scan/index.js'
export { guessProductKind, buildProductProfile } from './scan/product.js'
export { detectRoutes, sensitiveRoutes, roleForPath } from './scan/routes.js'
export { detectEventCalls, detectAnalyticsLibraries } from './scan/events.js'
export { generatePlan, planStats, stageForEvent } from './plan/generate.js'
export { resolveRoles, roleMap, ALL_ROLES, ROLE_DESCRIPTIONS, type EventRole } from './plan/roles.js'
export { suggestEvents } from './plan/suggestions.js'
export { PACKS, packById, packsForKind, resolvePacks } from './packs/index.js'
export {
  PostHogClient,
  PostHogError,
  REGIONS,
  hostsForRegion,
  customRegion,
  type RegionHosts,
} from './posthog/client.js'
export * as queries from './posthog/queries.js'
export { buildDashboards, computeLayouts, reportSkipped, syncDashboards } from './posthog/sync.js'
export {
  REQUIRED_SCOPES,
  OPTIONAL_SCOPES,
  authInstructions,
  keyPageUrl,
  resolvePersonalKey,
} from './posthog/auth.js'
export { emitAnalyticsModule, emitWiringSnippet } from './emit/analyticsTs.js'
export { emitWalkthrough } from './emit/walkthrough.js'
export { runDoctor, doctorExitCode, type CheckResult } from './doctor/index.js'
export { checkDrift, type CheckReport, type DriftItem } from './check.js'
export { computeMetrics, METRICS } from './metrics/compute.js'
export { discoverProject, guessKindFromEvents } from './metrics/discover.js'
export { formatMetric, formatChange, type MetricSet, type MetricValue } from './metrics/types.js'
export { metricById } from './metrics/definitions.js'
export { deriveFindings, healthScore, summarise, type Finding, type Severity } from './insights/findings.js'
export { bandFor, typicalRange, BENCHMARKS, KIND_LABELS } from './insights/benchmarks.js'
export { GOALS, GOAL_DEFINITIONS, applyGoal, goalBlindSpot, type Goal, type GoalContext } from './insights/goals.js'
export { buildDescriptions, toApply as descriptionsToApply } from './describe/descriptions.js'
export { renderHtmlReport } from './report/html.js'
export { renderTerminalReport } from './report/terminal.js'
export { generateDemoEvents, seedDemoData, makeRandom } from './demo/seed.js'
export {
  loadConfig,
  saveConfig,
  loadPlan,
  savePlan,
  buildConfig,
  publicKeyEnvFor,
  envStyleFor,
} from './config.js'
