/**
 * The shareable report.
 *
 * This is the artefact people send to a cofounder or post a screenshot of, so
 * it is the thing most worth making good. Constraints it holds to:
 *
 *   - **One file, no network.** Inline CSS, embedded fonts, no external
 *     anything. It has to open from a USB stick in five years and still look
 *     right, and a strict CSP must never be able to break it.
 *   - **Editorial, not dashboard.** Structure comes from type and from where the
 *     hairlines fall. No card shadows, no floating rounded boxes.
 *   - **Screenshot-friendly.** The top of the page is a self-contained summary:
 *     who made it, what the product is, one number, and the worst finding.
 *   - **Honest.** Every benchmark says it is a rule of thumb, every small sample
 *     is labelled, and the composite score explains exactly how it was derived
 *     rather than implying it measured something.
 *
 * House style is Dizko's: grey canvas, ink black, acid green, Instrument Sans
 * with IBM Plex Mono for micro-labels. The one hard rule about the palette is
 * that an acid fill always carries black ink on top, never white, so the accent
 * goes on the action block and never on body text.
 */

import type { MetricSet } from '../metrics/types.js'
import { formatMetric } from '../metrics/types.js'
import { metricById } from '../metrics/definitions.js'
import { KIND_LABELS, typicalRange } from '../insights/benchmarks.js'
import type { Finding, Severity } from '../insights/findings.js'
import { healthScore } from '../insights/findings.js'
import { IBM_PLEX_MONO_WOFF2, INSTRUMENT_SANS_WOFF2 } from './fonts.js'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  warning: 'Worth fixing',
  opportunity: 'Blind spot',
  strength: 'Working well',
}

const STYLES = `
@font-face {
  font-family: "Instrument Sans";
  src: url(data:font/woff2;base64,${INSTRUMENT_SANS_WOFF2}) format("woff2");
  font-weight: 100 900;
  font-display: swap;
}
@font-face {
  font-family: "IBM Plex Mono";
  src: url(data:font/woff2;base64,${IBM_PLEX_MONO_WOFF2}) format("woff2");
  font-weight: 500;
  font-display: swap;
}

:root {
  --acid: #C4F236;
  --acid-deep: #4E6B00;
  --ink: #0D0D0D;
  --black: #050505;
  --canvas: #D9D9D3;
  --paper: #ECECE6;
  --steel: #6F6F68;
  --secondary: #45453F;
  --rule: rgba(13, 13, 13, 0.22);
  --hair: rgba(13, 13, 13, 0.12);
  --danger: #C0392B;
  --sans: "Instrument Sans", "Helvetica Neue", Helvetica, Arial, sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ink: #ECECE6;
    --canvas: #0D0D0D;
    --paper: #171715;
    --steel: #96968C;
    --secondary: #B9B9B0;
    --rule: rgba(236, 236, 230, 0.24);
    --hair: rgba(236, 236, 230, 0.13);
    --danger: #E8705F;
  }
}

* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--canvas);
  color: var(--ink);
  font-family: var(--sans);
  font-size: 16px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 820px; margin: 0 auto; padding: 0 28px 120px; }

/* The mono uppercase tag, used for every label in the document. */
.tag {
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: .16em;
  text-transform: uppercase;
  color: var(--steel);
}

header { padding: 52px 0 0; }

.credit {
  border-top: 2px solid var(--ink);
  border-bottom: 1px solid var(--rule);
  padding: 14px 0;
  font-size: 13.5px;
  line-height: 1.5;
  color: var(--secondary);
  display: flex;
  gap: 8px 20px;
  flex-wrap: wrap;
  align-items: baseline;
}
.credit .who { flex: 0 0 auto; }
.credit .who b { color: var(--ink); font-weight: 650; }
.credit .what { flex: 1 1 340px; min-width: 0; }
a { color: var(--ink); text-decoration: none; border-bottom: 2px solid var(--acid); }
a:hover { background: var(--acid); color: var(--black); }

h1 {
  font-size: clamp(46px, 9vw, 88px);
  line-height: .9;
  letter-spacing: -.04em;
  font-weight: 700;
  margin: 34px 0 0;
}
.sub { color: var(--secondary); font-size: 15px; margin: 16px 0 0; }

/* Score band: one acid block, black ink on it, counts alongside. */
.band {
  margin: 32px 0 0;
  border-top: 1px solid var(--rule);
  border-bottom: 1px solid var(--rule);
  display: flex;
  align-items: stretch;
  flex-wrap: wrap;
}
.scorebox {
  background: var(--acid);
  color: var(--black);
  padding: 19px 26px 17px;
  display: flex;
  align-items: baseline;
  gap: 3px;
  flex: 0 0 auto;
}
.scorebox .n { font-size: 58px; font-weight: 700; letter-spacing: -.05em; line-height: .85; }
.scorebox .d { font-size: 17px; font-weight: 600; opacity: .6; }
.tally { display: flex; align-items: center; flex-wrap: wrap; flex: 1 1 auto; }
.count {
  padding: 14px 22px;
  border-left: 1px solid var(--hair);
  font-size: 13px;
  color: var(--steel);
  white-space: nowrap;
}
.count b { display: block; font-size: 25px; font-weight: 700; color: var(--ink); letter-spacing: -.025em; line-height: 1.15; }
.count.critical b { color: var(--danger); }
.scorebasis { font-size: 12.5px; color: var(--steel); margin: 14px 0 0; max-width: 68ch; line-height: 1.5; }

h2 {
  margin: 70px 0 0;
  padding: 0 0 11px;
  border-bottom: 2px solid var(--ink);
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: .18em;
  text-transform: uppercase;
  color: var(--ink);
}

/* Findings are separated by rules, never boxed. */
.finding { padding: 30px 0 34px; border-bottom: 1px solid var(--rule); }
.fmeta { display: flex; align-items: baseline; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
.sev { display: inline-flex; align-items: center; gap: 9px; }
.sev .dot { width: 9px; height: 9px; flex: 0 0 auto; }
.sev.critical .dot { background: var(--danger); }
.sev.warning .dot { background: var(--acid-deep); }
.sev.opportunity .dot { background: var(--steel); }
.sev.strength .dot { background: var(--acid); }
.sev .txt {
  font-family: var(--mono); font-size: 11px; font-weight: 500;
  letter-spacing: .16em; text-transform: uppercase; color: var(--secondary);
}
.sev.critical .txt { color: var(--danger); }
.fnum {
  font-size: 38px; font-weight: 700; letter-spacing: -.04em;
  font-variant-numeric: tabular-nums; white-space: nowrap; line-height: 1;
}
.ftitle {
  font-size: clamp(21px, 3.2vw, 28px);
  font-weight: 650;
  letter-spacing: -.025em;
  line-height: 1.18;
  margin: 15px 0 16px;
  max-width: 28ch;
}
.what { color: var(--steel); font-size: 14.5px; margin: 0 0 16px; max-width: 74ch; }
.why { margin: 0 0 22px; max-width: 74ch; color: var(--secondary); }

/* The action is the point of the document, so it takes the accent. */
.action { background: var(--acid); color: var(--black); padding: 17px 22px 19px; max-width: 74ch; }
.action .tag { color: var(--black); opacity: .6; display: block; margin-bottom: 7px; }
.action p { margin: 0; font-size: 15.5px; line-height: 1.5; }

.evidence { display: flex; flex-wrap: wrap; margin-top: 22px; border-top: 1px solid var(--hair); }
.ev { padding: 14px 34px 0 0; }
.ev .k {
  display: block; font-family: var(--mono); font-size: 10.5px; letter-spacing: .12em;
  text-transform: uppercase; color: var(--steel); margin-bottom: 5px;
}
.ev .v { font-size: 19px; font-weight: 700; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
.ev .t { font-size: 12px; color: var(--steel); margin-left: 7px; font-weight: 400; letter-spacing: 0; }
.roles .t { font-size: 12px; color: var(--steel); font-weight: 400; }

table { width: 100%; border-collapse: collapse; font-size: 14.5px; }
th {
  text-align: left; padding: 14px 0 10px; border-bottom: 1px solid var(--rule);
  font-family: var(--mono); font-size: 10.5px; font-weight: 500;
  letter-spacing: .14em; text-transform: uppercase; color: var(--steel);
}
td { padding: 13px 0; border-bottom: 1px solid var(--hair); vertical-align: baseline; }
td.n { text-align: right; font-variant-numeric: tabular-nums; font-weight: 700; white-space: nowrap; font-size: 16px; }
td.t { text-align: right; color: var(--steel); font-size: 12.5px; white-space: nowrap; font-family: var(--mono); }
.q { color: var(--steel); font-size: 12.5px; display: block; margin-top: 3px; }

.roles { display: grid; grid-template-columns: max-content 1fr; font-size: 14px; }
.roles > * { padding: 9px 0; border-bottom: 1px solid var(--hair); }
.roles .r { font-family: var(--mono); font-size: 12.5px; color: var(--acid-deep); padding-right: 24px; }
@media (prefers-color-scheme: dark) { .roles .r { color: var(--acid); } }
.roles .e { font-weight: 600; }

.note {
  background: var(--paper); padding: 17px 20px; margin-top: 22px;
  font-size: 13px; line-height: 1.55; color: var(--secondary);
  border-left: 3px solid var(--rule);
}
.note b { color: var(--ink); font-weight: 650; }
code { font-family: var(--mono); font-size: .92em; }

footer {
  margin-top: 74px; padding-top: 22px; border-top: 2px solid var(--ink);
  font-size: 13px; color: var(--steel); line-height: 1.6;
}
footer p { margin: 0 0 8px; }
.wordmark { font-weight: 700; letter-spacing: -.02em; color: var(--ink); }

@media (max-width: 620px) {
  .wrap { padding: 0 18px 80px; }
  header { padding-top: 32px; }
  .scorebox { flex: 1 1 100%; }
  .count { border-left: 0; border-top: 1px solid var(--hair); flex: 1 1 33%; }
  .fnum { font-size: 30px; }
  .ftitle { max-width: none; }
}
@media print {
  body { background: #fff; }
  .finding { break-inside: avoid; }
  .action { border: 1px solid var(--ink); }
}
`

export interface HtmlReportOptions {
  set: MetricSet
  findings: Finding[]
  generatedAt?: string
  projectUrl?: string
}

export function renderHtmlReport(options: HtmlReportOptions): string {
  const { set, findings } = options
  const context = set.context
  const score = healthScore(findings, set)
  const generatedAt = options.generatedAt ?? new Date().toISOString().slice(0, 10)

  const counts: Record<Severity, number> = {
    critical: findings.filter((finding) => finding.severity === 'critical').length,
    warning: findings.filter((finding) => finding.severity === 'warning').length,
    opportunity: findings.filter((finding) => finding.severity === 'opportunity').length,
    strength: findings.filter((finding) => finding.severity === 'strength').length,
  }

  const tally = (Object.keys(counts) as Severity[])
    .filter((severity) => counts[severity] > 0)
    .map((severity) => {
      const label = SEVERITY_LABEL[severity].toLowerCase()
      const plural = severity === 'opportunity' && counts[severity] !== 1 ? `${label}s` : label
      return `<div class="count ${severity}"><b>${counts[severity]}</b>${escapeHtml(plural)}</div>`
    })
    .join('')

  const findingsHtml = findings
    .map((finding) => {
      const evidenceHtml = finding.evidence.length
        ? `<div class="evidence">${finding.evidence
            .map(
              (item) =>
                `<div class="ev"><span class="k">${escapeHtml(item.label)}</span>` +
                `<span class="v">${escapeHtml(item.value)}` +
                (item.typical ? `<span class="t">typical ${escapeHtml(item.typical)}</span>` : '') +
                `</span></div>`,
            )
            .join('')}</div>`
        : ''

      return `
      <article class="finding">
        <div class="fmeta">
          <span class="sev ${finding.severity}"><span class="dot"></span><span class="txt">${escapeHtml(
            SEVERITY_LABEL[finding.severity],
          )}${finding.confidence === 'medium' ? ' · small sample' : ''}</span></span>
          ${finding.headline ? `<span class="fnum">${escapeHtml(finding.headline)}</span>` : ''}
        </div>
        <h3 class="ftitle">${escapeHtml(finding.title)}</h3>
        <p class="what">${escapeHtml(finding.what)}</p>
        <p class="why">${escapeHtml(finding.why)}</p>
        <div class="action"><span class="tag">Do this</span><p>${escapeHtml(finding.action)}</p></div>
        ${evidenceHtml}
      </article>`
    })
    .join('')

  const metricRows = Object.entries(set.values)
    .map(([id, metric]) => ({ id, metric, definition: metricById(id) }))
    .filter((entry) => entry.definition && entry.metric.value !== null)
    .map(({ id, metric, definition }) => {
      const typical = typicalRange(id, context.productKind)
      return `<tr>
        <td>${escapeHtml(definition!.name)}<span class="q">${escapeHtml(definition!.question)}${
          metric.confidence === 'low' ? ' (small sample)' : ''
        }</span></td>
        <td class="n">${escapeHtml(formatMetric(metric.value!, definition!.unit))}</td>
        <td class="t">${typical ? escapeHtml(typical) : ''}</td>
      </tr>`
    })
    .join('')

  const rolesHtml = Object.entries(context.roles)
    .map(([role, event]) => {
      const guessed = context.inferredRoles.includes(role)
        ? ' <span class="t">guessed from behaviour, not from the name</span>'
        : ''
      return `<div class="r">${escapeHtml(role)}</div><div class="e">${escapeHtml(event)}${guessed}</div>`
    })
    .join('')

  const topEvents = context.eventVolumes
    .slice(0, 12)
    .map(
      (entry) =>
        `<tr><td>${escapeHtml(entry.event)}</td><td class="n">${formatMetric(entry.people, 'count')}</td><td class="t">${formatMetric(entry.events, 'count')} events</td></tr>`,
    )
    .join('')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(context.projectName)} - product health</title>
<meta name="robots" content="noindex">
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">

<header>
  <div class="credit">
    <span class="who"><span class="tag">Built by</span> <b>Dizko Labs</b></span>
    <span class="what">Dizko uses real-world intelligence to help you discover events and coordinate going to them with your friends. <a href="https://www.dizko.app">dizko.app</a></span>
  </div>

  <div class="tag" style="margin-top:32px">Product health report</div>
  <h1>${escapeHtml(context.projectName)}</h1>
  <p class="sub">${escapeHtml(KIND_LABELS[context.productKind])} · ${formatMetric(context.activePeople, 'count')} people · ${formatMetric(context.totalEvents, 'count')} events · ${context.daysOfData} days of history</p>

  <div class="band">
    ${score ? `<div class="scorebox"><span class="n">${score.score}</span><span class="d">/100</span></div>` : ''}
    <div class="tally">${tally}</div>
  </div>
  ${score ? `<p class="scorebasis">${escapeHtml(score.basis)}</p>` : ''}
</header>

${
  findings.length
    ? `<h2>What to do about it</h2>${findingsHtml}`
    : `<div class="note">Not enough data to draw conclusions yet. Come back once a few hundred people have used the product.</div>`
}

<h2>Every number</h2>
<table>
  <thead><tr><th>Metric</th><th style="text-align:right">Value</th><th style="text-align:right">Typical</th></tr></thead>
  <tbody>${metricRows}</tbody>
</table>
<div class="note">
  <b>About the "typical" column.</b> These are rules of thumb drawn from widely repeated
  industry guidance, adjusted for ${escapeHtml(KIND_LABELS[context.productKind])}. They are not measured from a
  dataset of comparable products, and a healthy product can sit outside any of them.
  They are here because approximately-right context beats a bare number with none.
</div>

${
  context.unavailable.length
    ? `<h2>Not computed</h2><table><tbody>${context.unavailable
        .map(
          (item) =>
            `<tr><td>${escapeHtml(metricById(item.id)?.name ?? item.id)}<span class="q">${escapeHtml(item.reason.slice(0, 160))}</span></td></tr>`,
        )
        .join('')}</tbody></table>`
    : ''
}

<h2>How it read your events</h2>
<div class="roles">${rolesHtml || '<div class="r">none</div><div class="e">No recognisable roles were resolved.</div>'}</div>
<div class="note">
  Findings are written against semantic roles, then resolved against the events this project
  actually sends. If a mapping above is wrong, every number that used it is wrong too.
  Re-run with <code>--role activation=your_event</code> to correct it.
</div>

<h2>Busiest events</h2>
<table>
  <thead><tr><th>Event</th><th style="text-align:right">People</th><th style="text-align:right">Volume</th></tr></thead>
  <tbody>${topEvents}</tbody>
</table>

<footer>
  <p>Generated ${escapeHtml(generatedAt)} by <span class="wordmark">OpenHog</span>, an open-source tool from
  <a href="https://www.dizko.app">Dizko Labs</a>, from ${context.eventVolumes.length} event types in
  ${options.projectUrl ? `<a href="${escapeHtml(options.projectUrl)}">this PostHog project</a>` : 'PostHog'}.
  Nothing here left your machine except the queries that produced it.</p>
  <p><a href="https://github.com/ZakKrevitt/OpenHog">github.com/ZakKrevitt/OpenHog</a></p>
</footer>

</div>
</body>
</html>
`
}
