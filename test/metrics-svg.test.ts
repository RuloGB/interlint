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

  it.each([8, 13, 26, 52])("keeps the figures over %i weeks apart, so none is written over another", (count) => {
    const boxes = textBoxes(svg(weekly(count)))

    boxes.forEach((box, index) => {
      for (const other of boxes.slice(index + 1)) expect(overlap(box, other), `${box.content} and ${other.content}`).toBe(false)
    })
    expect(boxes.filter((box) => box.anchor === "middle" && /^\d+$/.test(box.content)).length).toBeGreaterThanOrEqual(4)
  })

  it("writes the figures over every week while they fit", () => {
    const totals = textBoxes(svg(weekly(8))).filter((box) => box.anchor === "middle" && /^\d+$/.test(box.content))

    expect(totals).toHaveLength(8)
  })
})

/** Weekly checks with as many violations, so the figure of each line point sits as high as the totals. */
function weekly(count: number): BarChart {
  const values = weeks(count).map((_, index) => 30 + (index % 3))
  return {
    kind: "bar",
    title: "Checks run (bars) and violations (line) per week",
    horizontal: false,
    axis: "Checks and violations",
    labels: weeks(count),
    series: [
      { name: "Checks run", values, as: "bar" },
      { name: "Violations", values, as: "line" },
    ],
  }
}

interface TextBox {
  content: string
  anchor: string
  left: number
  right: number
  top: number
  bottom: number
}

/** The room of each label and figure of a chart, leaving out the muted axis and legend. */
function textBoxes(drawn: string): TextBox[] {
  return [...drawn.matchAll(/<text x="([\d.]+)" y="([\d.]+)" text-anchor="(\w+)" fill="([^"]+)">(?:<title>[^<]*<\/title>)?([^<]*)<\/text>/g)]
    .filter(([, , , , fill]) => fill !== "#6b7280")
    .map(([, x, y, anchor = "start", , content = ""]) => {
      const width = content.length * 6.8
      const left = anchor === "middle" ? Number(x) - width / 2 : Number(x)
      return { content, anchor, left, right: left + width, top: Number(y) - 10, bottom: Number(y) }
    })
}

function overlap(one: TextBox, other: TextBox): boolean {
  return one.left < other.right && other.left < one.right && one.top < other.bottom && other.top < one.bottom
}

/** The width of a `YYYY-MM-DD` label at 12px. */
const DATE_WIDTH = 10 * 6.8
/** The width of a `YYYY-MM-DD` label with a little room around it. */
const LABEL_WIDTH = DATE_WIDTH + 6.8

/** `count` Mondays, as the report labels its weeks. */
function weeks(count: number): string[] {
  const first = Date.UTC(2026, 7, 3)
  return Array.from({ length: count }, (_, index) => new Date(first + index * 7 * 86_400_000).toISOString().slice(0, 10))
}
