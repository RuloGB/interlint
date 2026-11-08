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

  it("keeps a chart with a line upright, shortening its labels, since a line runs along the labels", () => {
    expect(svg(bars(MODELS, true))).toContain("<polyline")
  })
})
