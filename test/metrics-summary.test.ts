import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { fileMetrics, fileMetricsSource } from "../src/adapters/driven/state/file-metrics.js"
import { projectKey } from "../src/adapters/driven/state/user-state.js"
import { type MetricEvent, metricEventOf } from "../src/domain/metric.js"
import { summarize } from "../src/domain/metric-summary.js"

/** A line of format 1 exactly as Interlint 1.10.0 writes it. It must stay readable. */
const V1_LINE =
  '{"v":1,"at":"2026-11-05T10:20:30.000Z","interlint":"1.10.0","projectKey":"3f2a9c1d0b7e4a65","project":"shop","when":"edit","check":"pmd","report":"maven","result":"violations","durationMs":2140,"violations":[{"rule":"EmptyCatchBlock","type":"pmd","file":"src/main/java/shop/Order.java"}],"agent":"claude-code","session":"9bab2274","model":"claude-opus-5-5"}'

/** An event with what every event has, and `fields` on top. */
function event(fields: Partial<MetricEvent>): MetricEvent {
  return {
    v: 1,
    at: "2026-11-05T10:00:00.000Z",
    interlint: "1.10.0",
    projectKey: "k",
    project: "shop",
    when: "edit",
    check: "pmd",
    report: "maven",
    result: "passed",
    durationMs: 100,
    ...fields,
  }
}

const violations = (...rules: [string, "architecture" | "checkstyle" | "pmd"][]) =>
  rules.map(([rule, type]) => ({ rule, type }))

describe("reading a metrics line", () => {
  it("reads a line of format 1 as it was written", () => {
    expect(metricEventOf(JSON.parse(V1_LINE))).toEqual({
      v: 1,
      at: "2026-11-05T10:20:30.000Z",
      interlint: "1.10.0",
      projectKey: "3f2a9c1d0b7e4a65",
      project: "shop",
      when: "edit",
      check: "pmd",
      report: "maven",
      result: "violations",
      durationMs: 2140,
      violations: [{ rule: "EmptyCatchBlock", type: "pmd", file: "src/main/java/shop/Order.java" }],
      agent: "claude-code",
      session: "9bab2274",
      model: "claude-opus-5-5",
    })
  })

  it.each([
    ["not an object", 3],
    ["an unknown format version", { ...JSON.parse(V1_LINE), v: 2 }],
    ["an unknown result", { ...JSON.parse(V1_LINE), result: "maybe" }],
    ["a negative duration", { ...JSON.parse(V1_LINE), durationMs: -1 }],
    ["a date that is not a date", { ...JSON.parse(V1_LINE), at: "yesterday" }],
    ["a violation without its rule", { ...JSON.parse(V1_LINE), violations: [{ type: "pmd" }] }],
  ])("is no event when it holds %s", (_case, value) => {
    expect(metricEventOf(value)).toBeUndefined()
  })
})

describe("the summary of the metrics", () => {
  it("counts the checks that ran apart from those skipped, and every violation of every run", () => {
    const summary = summarize([
      event({ result: "violations", violations: violations(["LineLength", "checkstyle"]) }),
      event({ result: "violations", violations: violations(["LineLength", "checkstyle"], ["ARCH-01", "architecture"]) }),
      event({ result: "skipped", skipped: "pending", durationMs: 0 }),
      event({ result: "passed" }),
    ])

    expect(summary.checksRun).toBe(3)
    expect(summary.skipped).toBe(1)
    expect(summary.violations).toBe(3)
    expect(summary.byType).toEqual([
      { type: "checkstyle", violations: 2 },
      { type: "architecture", violations: 1 },
    ])
    expect(summary.rules).toEqual([
      { rule: "LineLength", type: "checkstyle", violations: 2 },
      { rule: "ARCH-01", type: "architecture", violations: 1 },
    ])
  })

  it("gives a violation without its type the type of its check's report", () => {
    const summary = summarize([
      event({ report: "archunit", result: "violations", violations: [{ rule: "ARCH-01" }] }),
      event({ report: "maven", result: "violations", violations: [{ rule: "Odd" }] }),
    ])

    expect(summary.byType).toEqual([
      { type: "architecture", violations: 1 },
      { type: "other", violations: 1 },
    ])
  })

  it("compares models by violations per check run, with the checks and sessions behind, and no model as unknown", () => {
    const summary = summarize([
      event({ model: "big", agent: "claude-code", session: "a", result: "violations", violations: violations(["R", "pmd"]) }),
      event({ model: "big", agent: "claude-code", session: "a" }),
      event({ model: "big", agent: "claude-code", session: "b" }),
      event({ model: "big", agent: "claude-code", session: "b", result: "skipped", skipped: "pending" }),
      event({ result: "violations", violations: violations(["R", "pmd"], ["S", "pmd"]) }),
    ])

    expect(summary.byModel).toEqual([
      { name: "big", checks: 3, violations: 1, sessions: 2 },
      { name: "unknown", checks: 1, violations: 2, sessions: 0 },
    ])
    expect(summary.byAgent).toEqual([
      { name: "claude-code", checks: 3, violations: 1, sessions: 2 },
      { name: "manual", checks: 1, violations: 2, sessions: 0 },
    ])
  })

  it("counts a failed task end of an agent's session as a block, fixed when a later task end passes", () => {
    const run = (at: string, session: string, result: MetricEvent["result"]) =>
      event({ at, when: "task-end", agent: "claude-code", session, model: "m", result })
    const summary = summarize([
      run("2026-11-05T10:00:00.000Z", "a", "violations"),
      run("2026-11-05T10:01:00.000Z", "a", "failed"),
      run("2026-11-05T10:02:00.000Z", "a", "passed"),
      run("2026-11-05T11:00:00.000Z", "b", "violations"),
      // By hand: no session, so no block.
      event({ when: "task-end", result: "violations" }),
      // An edit that fails blocks nothing.
      event({ agent: "claude-code", session: "b", result: "violations" }),
    ])

    expect(summary.blocks).toBe(3)
    expect(summary.fixed).toBe(2)
    expect(summary.blocksByModel).toEqual([{ name: "m", blocks: 3, fixed: 2 }])
    expect(summary.sessions.map(({ session, blocks, fixed, endedGreen }) => ({ session, blocks, fixed, endedGreen }))).toEqual([
      { session: "a", blocks: 2, fixed: 2, endedGreen: true },
      { session: "b", blocks: 1, fixed: 0, endedGreen: false },
    ])
  })

  it("takes the lines written at the same moment as one run, so one failing check blocks once", () => {
    const at = "2026-11-05T10:00:00.000Z"
    const summary = summarize([
      event({ at, when: "task-end", agent: "opencode", session: "s", check: "pmd", result: "violations" }),
      event({ at, when: "task-end", agent: "opencode", session: "s", check: "architecture", result: "violations" }),
      event({ at, when: "task-end", agent: "opencode", session: "s", check: "checkstyle", result: "skipped" }),
    ])

    expect(summary.blocks).toBe(1)
  })

  it("adds up the time spent on checks by check and moment, and counts checks per session", () => {
    const summary = summarize([
      event({ session: "a", agent: "opencode", check: "pmd", when: "edit", durationMs: 1000 }),
      event({ session: "a", agent: "opencode", check: "pmd", when: "edit", durationMs: 3000 }),
      event({ session: "b", agent: "opencode", check: "pmd", when: "task-end", durationMs: 500 }),
    ])

    expect(summary.waitMs).toBe(4500)
    expect(summary.waitByCheck).toEqual([
      { check: "pmd", when: "edit", runs: 2, totalMs: 4000 },
      { check: "pmd", when: "task-end", runs: 1, totalMs: 500 },
    ])
    expect(summary.sessions.map(({ session, checks }) => ({ session, checks }))).toEqual([
      { session: "a", checks: 2 },
      { session: "b", checks: 1 },
    ])
  })

  it("groups checks and violations by week, from Monday in UTC", () => {
    const summary = summarize([
      // Wednesday and Sunday of the same week, then the next Monday.
      event({ at: "2026-11-04T09:00:00.000Z", result: "violations", violations: violations(["R", "pmd"]) }),
      event({ at: "2026-11-08T23:59:00.000Z" }),
      event({ at: "2026-11-09T00:00:00.000Z" }),
    ])

    expect(summary.byWeek).toEqual([
      { week: "2026-11-02", checks: 2, violations: 1 },
      { week: "2026-11-09", checks: 1, violations: 0 },
    ])
    expect(summary.from).toBe("2026-11-04")
    expect(summary.to).toBe("2026-11-09")
  })
})

describe("the metrics as read from the user's state directory", () => {
  let stateDir: string
  let projectDir: string

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "interlint-metrics-read-"))
    projectDir = mkdtempSync(join(tmpdir(), "interlint-metrics-project-"))
  })

  afterEach(() => {
    for (const dir of [stateDir, projectDir]) rmSync(dir, { recursive: true, force: true })
  })

  it("reads back what the sink wrote, month after month", () => {
    const months = ["2026-10-31T23:00:00.000Z", "2026-11-01T01:00:00.000Z"]
    for (const at of months) {
      fileMetrics(stateDir, () => new Date(at))(projectDir, [{ when: "edit", check: "pmd", report: "maven", result: "passed", durationMs: 7 }])
    }

    const read = fileMetricsSource(stateDir).read({ projectDir })

    expect(read.events.map((metric) => metric.at)).toEqual(months)
    expect(read.unreadable).toBe(0)
  })

  it("skips a line that is not an event and counts it", () => {
    const dir = join(stateDir, projectKey(projectDir))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "2026-11.jsonl"), `${V1_LINE}\nedited by hand\n{"v":1}\n\n${V1_LINE}\n`)

    const read = fileMetricsSource(stateDir).read({ projectDir })

    expect(read.events).toHaveLength(2)
    expect(read.unreadable).toBe(2)
  })

  it("reads only the current project, or every project with all", () => {
    const other = mkdtempSync(join(tmpdir(), "interlint-metrics-other-"))
    try {
      const sink = fileMetrics(stateDir)
      sink(projectDir, [{ when: "edit", check: "pmd", report: "maven", result: "passed", durationMs: 1 }])
      sink(other, [{ when: "edit", check: "pmd", report: "maven", result: "passed", durationMs: 1 }])

      const source = fileMetricsSource(stateDir)

      expect(source.read({ projectDir }).events).toHaveLength(1)
      expect(source.read({ all: true }).events).toHaveLength(2)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it("reads nothing, and says where metrics are kept, for a project without metrics", () => {
    const source = fileMetricsSource(stateDir)

    expect(source.read({ projectDir })).toEqual({ events: [], unreadable: 0 })
    expect(source.location({ projectDir })).toBe(join(stateDir, projectKey(projectDir)))
    expect(source.location({ all: true })).toBe(stateDir)
  })
})
