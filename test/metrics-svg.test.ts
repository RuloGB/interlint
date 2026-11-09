import { describe, expect, it } from "vitest"
import type { BarChart } from "../src/application/metrics/report.js"
import { svg } from "../src/application/metrics/svg.js"

const MODELS = ["claude-sonnet-5-5", "gpt-5", "claude-haiku-5-5", "claude-opus-5-5", "gpt-4.1-mini", "gemini-2.5-pro", "qwen3-coder"]

function bars(labels: string[], line = false): BarChart {
  return {
    kind: "bar",
    title: "Violations per check run by model",
    horizontal: false,
    axis: "Violations per check run",
    labels,
    series: [
      { name: "Violations", values: labels.map((_, index) => index + 1), as: "bar" },
      ...(line ? [{ name: "Checks", values: labels.map(() => 1), as: "line" as const }] : []),
    ],
  }
}

describe("a bar chart in SVG", () => {
  it("lays the bars along when their labels would not fit under them, so no label is cut", () => {
    const drawn = svg(bars(MODELS))

    for (const model of MODELS) expect(drawn).toContain(`>${model}</text>`)
    expect(drawn).not.toContain("…")
    expect(drawn).toContain('text-anchor="end"')
  })

  it("keeps the bars upright when the labels fit", () => {
    const drawn = svg(bars(["architecture", "checkstyle", "pmd"]))

    expect(drawn).toContain('text-anchor="middle" fill="#1f2937">architecture</text>')
  })

  it("keeps a chart with a line upright, since a line runs along the labels", () => {
    expect(svg(bars(MODELS, true))).toContain("<polyline")
  })

  it("shows every week under its bar while the weeks fit", () => {
    const labels = weeks(6)
    const drawn = svg(bars(labels, true))

    for (const week of labels) expect(drawn).toContain(`text-anchor="middle" fill="#1f2937">${week}</text>`)
  })

  it.each([8, 13, 26, 29, 52])("shows the weeks of %i weeks in full, with room between them, instead of cutting them", (count) => {
    const labels = weeks(count)
    const drawn = svg(bars(labels, true))
    const width = Number(/viewBox="0 0 ([\d.]+) /.exec(drawn)?.[1])
    const shown = [...drawn.matchAll(/<text x="([\d.]+)"[^>]*>(\d{4}-\d{2}-\d{2})<\/text>/g)].map(([, x, week]) => ({ x: Number(x), week }))

    expect(drawn).not.toContain("…")
    expect(shown[0]?.week).toBe(labels[0])
    expect(shown.length).toBeGreaterThanOrEqual(4)
    for (const { week } of shown) expect(labels).toContain(week)
    shown.slice(1).forEach(({ x }, index) => expect(x - (shown[index]?.x ?? 0)).toBeGreaterThanOrEqual(LABEL_WIDTH))
    for (const { x } of shown) expect(x + DATE_WIDTH / 2).toBeLessThanOrEqual(width)
  })
})

/** The width of a `YYYY-MM-DD` label at 12px. */
const DATE_WIDTH = 10 * 6.8
/** The width of a `YYYY-MM-DD` label with a little room around it. */
const LABEL_WIDTH = DATE_WIDTH + 6.8

/** `count` Mondays, as the report labels its weeks. */
function weeks(count: number): string[] {
  const first = Date.UTC(2026, 7, 3)
  return Array.from({ length: count }, (_, index) => new Date(first + index * 7 * 86_400_000).toISOString().slice(0, 10))
}
