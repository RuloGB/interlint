import type { BarChart, Chart, PieChart } from "./report.js"

/** Longest label drawn: a long ArchUnit rule would squeeze the chart. The table keeps the whole name. */
const LABEL_LENGTH = 40

/** A chart as a Mermaid block, which GitHub draws. */
export function mermaid(chart: Chart): string {
  const body = chart.kind === "pie" ? pie(chart) : xychart(chart)
  return ["```mermaid", ...body, "```"].join("\n")
}

function pie(chart: PieChart): string[] {
  return [
    "pie showData",
    `    title ${chart.title}`,
    ...chart.slices.map(({ label, value }) => `    ${quoted(label)} : ${value}`),
  ]
}

/** `xychart-beta` draws several bar series on top of each other, so stacked bars become one bar per label and series. */
function xychart(chart: BarChart): string[] {
  const bars = chart.series.filter((series) => series.as === "bar")
  const stacked = bars.length > 1
  const points = stacked
    ? chart.labels.flatMap((label, index) =>
        bars.flatMap((series) => {
          const value = series.values[index] ?? 0
          return value === 0 ? [] : [{ label: `${label} ${series.name}`, value }]
        }),
      )
    : chart.labels.map((label, index) => ({ label, value: bars[0]?.values[index] ?? 0 }))
  return [
    chart.horizontal ? "xychart-beta horizontal" : "xychart-beta",
    `    title ${quoted(chart.title)}`,
    `    x-axis [${points.map(({ label }) => quoted(shortened(label))).join(", ")}]`,
    `    y-axis ${quoted(chart.axis)}`,
    ...(bars.length === 0 ? [] : [`    bar [${points.map(({ value }) => value).join(", ")}]`]),
    ...(stacked ? [] : chart.series.filter((series) => series.as === "line").map((series) => `    line [${series.values.join(", ")}]`)),
  ]
}

function shortened(label: string): string {
  return label.length <= LABEL_LENGTH ? label : `${label.slice(0, LABEL_LENGTH - 1)}…`
}

/** A Mermaid string: it has no escape for `"`, and a line break would end the statement. */
function quoted(text: string): string {
  return `"${text.replaceAll('"', "'").replace(/\s+/g, " ")}"`
}
