import type { BarChart, Chart, PieChart } from "./report.js"

/** Series colors, in order: they stay apart in print and for most color blindness. */
export const PALETTE = ["#2563eb", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16", "#64748b", "#f97316"]

const FONT = 12
/** A rough width of one character at `FONT`, to keep labels inside the drawing. */
const CHAR = 6.8
const INK = "#1f2937"
const MUTED = "#6b7280"
const GRID = "#e5e7eb"

/** A chart as inline SVG, sized by its viewBox so it scales with the page. */
export function svg(chart: Chart): string {
  if (chart.kind === "pie") return pie(chart)
  return chart.horizontal || !labelsFitUnder(chart) ? horizontalBars(chart) : verticalBars(chart)
}

/** Room for the labels of upright bars: the plot of `verticalBars`, shared by the labels. */
const VERTICAL_PLOT_WIDTH = 576

/**
 * Whether every label fits under its upright bar. When one does not, the bars are laid along, as for rule names, so no
 * label is cut; a chart with a line stays upright, since its line runs along the labels, and shows only some of them.
 */
function labelsFitUnder(chart: BarChart): boolean {
  if (chart.series.some((series) => series.as === "line")) return true
  const room = labelRoom(VERTICAL_PLOT_WIDTH / chart.labels.length)
  return chart.labels.every((label) => label.length <= room)
}

/** How many characters fit under a bar of `band` width. */
function labelRoom(band: number): number {
  return Math.max(4, Math.floor(band / CHAR) - 1)
}

/**
 * Every how many upright bars a label is shown: 1 when all fit, more for many weeks, so each shown label is whole and
 * has the room of the bars up to the next one.
 */
function labelEvery(labels: string[], band: number): number {
  const longest = Math.max(...labels.map((label) => label.length))
  let every = 1
  while (every < labels.length && labelRoom(band * every) < longest) every += 1
  return every
}

export function escapeXml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;")
}

function verticalBars(chart: BarChart): string {
  const left = 48
  const right = 16
  const width = left + VERTICAL_PLOT_WIDTH + right
  const top = 24
  const plot = 200
  const bottom = 28
  const legend = legendOf(chart)
  const height = top + plot + bottom + (legend.length > 0 ? 24 : 0)
  const bars = chart.series.filter((series) => series.as === "bar")
  const lines = chart.series.filter((series) => series.as === "line")
  const { max, step } = axisOf(Math.max(...stackHeights(chart), ...lines.flatMap((series) => series.values)))
  const band = VERTICAL_PLOT_WIDTH / chart.labels.length
  const every = labelEvery(chart.labels, band)
  const labelLength = labelRoom(band * every)
  const y = (value: number) => top + plot - (value / max) * plot
  const barWidth = Math.min(band * 0.6, 72)
  const parts = [...yGrid(max, step, left, width - right, y)]

  chart.labels.forEach((label, index) => {
    const x = left + band * index + (band - barWidth) / 2
    let base = 0
    bars.forEach((series) => {
      const value = series.values[index] ?? 0
      if (value === 0) return
      parts.push(rect(x, y(base + value), barWidth, y(base) - y(base + value), color(chart, series.name)))
      base += value
    })
    if (base > 0) parts.push(text(x + barWidth / 2, y(base) - 4, number(base), { anchor: "middle", fill: INK }))
    const shown = shortened(label, labelLength)
    const center = left + band * index + band / 2
    // A shown label is wider than its bar when only some are shown: the last one may not fit before the edge.
    if (index % every !== 0 || center + (shown.length * CHAR) / 2 > width) return
    parts.push(text(center, top + plot + 16, shown, { anchor: "middle", fill: INK, title: label }))
  })
  lines.forEach((series) => {
    const points = series.values.map((value, index) => [left + band * index + band / 2, y(value)] as const)
    const stroke = color(chart, series.name)
    parts.push(
      `<polyline points="${points.map(([px, py]) => `${round(px)},${round(py)}`).join(" ")}" fill="none" stroke="${stroke}" stroke-width="2"/>`,
      ...points.flatMap(([px, py], index) => [
        `<circle cx="${round(px)}" cy="${round(py)}" r="3.5" fill="${stroke}"/>`,
        text(px + 8, py - 6, number(series.values[index] ?? 0), { fill: stroke }),
      ]),
    )
  })
  parts.push(...legendItems(legend, left, top + plot + bottom + 14))
  return frame(chart.title, width, height, parts)
}

/** Characters of a label beside a horizontal bar: the rest shows on hover. */
const HORIZONTAL_LABEL = 40

/** One row per label: the label on the left, the bar, and its total on the right. */
function horizontalBars(chart: BarChart): string {
  const width = 720
  const gap = 8
  const labelWidth = HORIZONTAL_LABEL * CHAR
  const valueWidth = 48
  const row = 26
  const height = gap + row * chart.labels.length + gap
  const bars = chart.series.filter((series) => series.as === "bar")
  const totals = stackHeights(chart)
  const scale = (width - labelWidth - valueWidth - gap) / Math.max(...totals, 1)
  const parts: string[] = []
  chart.labels.forEach((label, index) => {
    const y = gap + row * index
    const baseline = y + row / 2 + 4
    parts.push(text(labelWidth - gap, baseline, shortened(label, HORIZONTAL_LABEL), { anchor: "end", fill: INK, title: label }))
    let base = 0
    bars.forEach((series) => {
      const value = series.values[index] ?? 0
      if (value === 0) return
      parts.push(rect(labelWidth + base * scale, y + 4, value * scale, row - 8, color(chart, series.name)))
      base += value
    })
    parts.push(text(labelWidth + base * scale + 6, baseline, number(totals[index] ?? 0), { fill: INK }))
  })
  return frame(chart.title, width, height, parts)
}

function pie(chart: PieChart): string {
  const width = 680
  const radius = 90
  const cx = 16 + radius
  const legendTop = 16
  const height = Math.max(2 * radius + 32, legendTop + chart.slices.length * 22 + 8)
  const cy = height / 2
  const total = chart.slices.reduce((all, slice) => all + slice.value, 0)
  const parts: string[] = []
  let angle = -Math.PI / 2
  chart.slices.forEach((slice, index) => {
    const fill = PALETTE[index % PALETTE.length] as string
    const share = slice.value / total
    if (share === 1) {
      parts.push(`<circle cx="${cx}" cy="${round(cy)}" r="${radius}" fill="${fill}"/>`)
    } else {
      const end = angle + share * 2 * Math.PI
      const [x1, y1] = [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]
      const [x2, y2] = [cx + radius * Math.cos(end), cy + radius * Math.sin(end)]
      parts.push(
        `<path d="M${cx},${round(cy)} L${round(x1)},${round(y1)} A${radius},${radius} 0 ${share > 0.5 ? 1 : 0} 1 ${round(x2)},${round(y2)} Z" fill="${fill}" stroke="#fff" stroke-width="1.5"/>`,
      )
      angle = end
    }
    const ly = legendTop + index * 22
    const lx = cx + radius + 32
    parts.push(
      rect(lx, ly, 12, 12, fill),
      text(lx + 20, ly + 11, `${shortened(slice.label, 44)} · ${number(slice.value)} (${Math.round(share * 100)}%)`, { fill: INK, title: slice.label }),
    )
  })
  return frame(chart.title, width, height, parts)
}

/** The height of each label's stack of bars: the sum of its bar series. */
function stackHeights(chart: BarChart): number[] {
  const bars = chart.series.filter((series) => series.as === "bar")
  return chart.labels.map((_, index) => bars.reduce((total, series) => total + (series.values[index] ?? 0), 0))
}

/** The series named in a legend: only when there is more than one. */
function legendOf(chart: BarChart): { name: string; color: string }[] {
  return chart.series.length > 1 ? chart.series.map((series) => ({ name: series.name, color: color(chart, series.name) })) : []
}

function legendItems(legend: { name: string; color: string }[], left: number, y: number): string[] {
  let x = left
  return legend.flatMap(({ name, color }) => {
    const item = [rect(x, y - 10, 12, 12, color), text(x + 18, y, name, { fill: MUTED })]
    x += 18 + name.length * CHAR + 20
    return item
  })
}

function color(chart: BarChart, series: string): string {
  return PALETTE[Math.max(0, chart.series.findIndex((each) => each.name === series)) % PALETTE.length] as string
}

function yGrid(max: number, step: number, from: number, to: number, y: (value: number) => number): string[] {
  return Array.from({ length: Math.round(max / step) + 1 }, (_, index) => step * index).flatMap((value) => [
    `<line x1="${from}" x2="${to}" y1="${round(y(value))}" y2="${round(y(value))}" stroke="${GRID}"/>`,
    text(from - 6, y(value) + 4, number(value), { anchor: "end", fill: MUTED }),
  ])
}

/** The top of the axis and the step between grid lines: round numbers, about five lines, at or above `value`. */
function axisOf(value: number): { max: number; step: number } {
  if (value <= 0) return { max: 1, step: 0.25 }
  const rough = value / 5
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const step = ([1, 2, 5, 10].find((each) => each * magnitude >= rough) ?? 10) * magnitude
  return { max: Math.ceil(value / step - 1e-9) * step, step }
}

function frame(title: string, width: number, height: number, parts: string[]): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${round(height)}" role="img" aria-label="${escapeXml(title)}" font-family="inherit" font-size="${FONT}">`,
    `<title>${escapeXml(title)}</title>`,
    ...parts,
    "</svg>",
  ].join("\n")
}

function rect(x: number, y: number, width: number, height: number, fill: string): string {
  return `<rect x="${round(x)}" y="${round(y)}" width="${round(width)}" height="${round(height)}" rx="2" fill="${fill}"/>`
}

function text(x: number, y: number, content: string, { anchor = "start", fill, title }: { anchor?: string; fill: string; title?: string }): string {
  const tooltip = title !== undefined && title !== content ? `<title>${escapeXml(title)}</title>` : ""
  return `<text x="${round(x)}" y="${round(y)}" text-anchor="${anchor}" fill="${fill}">${tooltip}${escapeXml(content)}</text>`
}

function shortened(label: string, length: number): string {
  const flat = label.replace(/\s+/g, " ")
  return flat.length <= length ? flat : `${flat.slice(0, length - 1)}…`
}

function number(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(value < 10 ? 2 : 1).replace(/\.?0+$/, "")
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}
