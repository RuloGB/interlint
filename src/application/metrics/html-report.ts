import type { MetricsSummary } from "../../domain/metric-summary.js"
import { skippedLines } from "./format-metrics.js"
import { INTERLINT_LOGO } from "./logo.js"
import { type Report, reportOf } from "./report.js"
import { escapeXml as escape, svg } from "./svg.js"

/** The full report as one HTML file, with inline SVG charts and print styles: it opens anywhere and prints to PDF. */
export function formatHtmlReport(summary: MetricsSummary, unreadable: number, filters: string[], generated: Date): string {
  const report = reportOf(summary, skippedLines(unreadable), filters, generated)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Interlint metrics</title>
<style>
${STYLE}
</style>
</head>
<body>
<main>
${header(report)}
${report.sections.map(section).join("\n")}
${report.notes === "" ? "" : `<p class="note">${escape(report.notes)}</p>`}
</main>
</body>
</html>
`
}

function header(report: Report): string {
  const facts = [
    `<span>${escape(report.projects.join(", "))}</span>`,
    `<span>${escape(`${report.from} to ${report.to} (UTC)`)}</span>`,
    ...(report.filters.length > 0 ? [`<span>Filtered by ${report.filters.map((filter) => `<code>${escape(filter)}</code>`).join(", ")}</span>`] : []),
    `<span>Generated on ${escape(report.generated)}</span>`,
  ]
  return `<header>
<div class="brand">${INTERLINT_LOGO}</div>
<h1>Metrics report</h1>
<p class="facts">${facts.join("")}</p>
<div class="headline">
${report.headline.map(({ label, value }) => `<div><strong>${escape(value)}</strong><span>${escape(label)}</span></div>`).join("\n")}
</div>
</header>`
}

function section({ title, charts, table, note }: Report["sections"][number]): string {
  return `<section>
<h2>${escape(title)}</h2>
${charts.length === 0 ? "" : `<div class="charts">\n${charts.map((chart) => `<figure>${chart.title === title ? "" : `<figcaption>${escape(chart.title)}</figcaption>`}\n${svg(chart)}\n</figure>`).join("\n")}\n</div>`}
${
  table.rows.length === 0
    ? "<p>None.</p>"
    : `<table>
<thead><tr>${table.headers.map((cell, index) => `<th${typeof table.rows[0]?.[index] === "number" ? ' class="number"' : ""}>${escape(cell)}</th>`).join("")}</tr></thead>
<tbody>
${table.rows.map((row) => `<tr>${row.map((cell) => `<td${typeof cell === "number" ? ' class="number"' : ""}>${escape(String(cell))}</td>`).join("")}</tr>`).join("\n")}
</tbody>
</table>`
}
${note === undefined ? "" : `<p class="note">${escape(note)}</p>`}
</section>`
}

const STYLE = `:root { color-scheme: light; --ink: #111827; --muted: #6b7280; --line: #e5e7eb; --accent: #059669; --soft: #f3f4f6; }
* { box-sizing: border-box; }
body { margin: 0; background: #fff; color: var(--ink); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 960px; margin: 0 auto; padding: 32px 16px 48px; }
header { border-bottom: 3px solid var(--accent); padding-bottom: 20px; margin-bottom: 8px; }
.brand { margin: 0 0 16px; }
.brand svg { width: auto; height: 40px; }
h1 { margin: 4px 0 8px; font-size: 28px; }
.facts { margin: 0 0 20px; color: var(--muted); display: flex; flex-wrap: wrap; gap: 4px 16px; }
.headline { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
.headline div { background: var(--soft); border-radius: 8px; padding: 12px 16px; }
.headline strong { display: block; font-size: 26px; font-variant-numeric: tabular-nums; }
.headline span { color: var(--muted); }
section { margin-top: 28px; }
h2 { font-size: 18px; margin: 0 0 12px; padding-bottom: 4px; border-bottom: 1px solid var(--line); }
.charts { display: grid; gap: 20px; margin-bottom: 12px; }
figure { margin: 0; break-inside: avoid; }
figcaption { font-weight: 600; margin-bottom: 4px; }
svg { width: 100%; height: auto; display: block; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; }
th { background: var(--soft); font-weight: 600; overflow-wrap: normal; }
th.number { text-align: right; }
td.number { text-align: right; font-variant-numeric: tabular-nums; }
code { background: var(--soft); padding: 0 4px; border-radius: 4px; }
.note { color: var(--muted); font-size: 13px; }
@media print {
  @page { size: A4; margin: 14mm; }
  body { font-size: 12px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  main { max-width: none; padding: 0; }
  thead { display: table-header-group; }
  tr, figure { break-inside: avoid; }
  h2 { break-after: avoid; }
}`
