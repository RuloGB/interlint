import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { fileMetrics } from "../src/adapters/driven/state/file-metrics.js"
import { projectKey } from "../src/adapters/driven/state/user-state.js"
import type { MetricsSink, ReportResult } from "../src/application/checking/ports.js"
import { type CheckDeps, runEditChecks, runTaskEndChecks } from "../src/application/checking/run-checks.js"
import type { Check, Config } from "../src/domain/check.js"
import type { CheckMetric } from "../src/domain/metric.js"

const PASSING: ReportResult = { found: true, failures: [] }

/** Fake adapters whose reader gives `result`, and a sink that keeps what it is given. */
function fakeDeps(result: ReportResult = PASSING, options: { changed?: boolean; fresh?: boolean } = {}) {
  const recorded: CheckMetric[][] = []
  const metrics: MetricsSink = (_projectDir, run) => void recorded.push(run)
  const reader = {
    snapshot: () => new Map(),
    read: () => result,
    readFresh: options.fresh ? () => PASSING : undefined,
  }
  const deps: CheckDeps = {
    run: async () => ({ exitCode: result.failures.length > 0 ? 1 : 0, output: "" }),
    readers: { archunit: reader, maven: reader, jacoco: reader },
    hasExecutable: () => true,
    lock: (_projectDir, work) => work(),
    changes: {
      lookup: () => ({ changed: options.changed ?? true, record: undefined, fingerprint: "", lastModifiedMs: 0 }),
      accept: () => {},
      touch: () => {},
    },
    hasDirectory: () => true,
    editScopes: {},
    removeBrokenClasses: () => [],
    pending: { list: () => [], save: () => true },
    metrics,
  }
  return { deps, recorded }
}

const pmd: Check = { name: "pmd", run: "node pmd.mjs", report: "maven", when: "edit" }
const architecture: Check = { name: "architecture", run: "node arch.mjs", report: "archunit", when: "task-end" }

const PMD_FAILURE: ReportResult = {
  found: true,
  failures: [
    {
      title: "EmptyCatchBlock",
      type: "pmd",
      violations: [
        { text: "Avoid empty catch blocks", file: "Order.java", line: 11, path: "src/main/java/shop/Order.java" },
        { text: "Avoid empty catch blocks", file: "Cart.java", line: 3, path: "src/main/java/shop/Cart.java" },
      ],
    },
  ],
}

describe("the metrics of a run of checks", () => {
  it("records one metric for each check that ran, with its moment, report, result and duration", async () => {
    const { deps, recorded } = fakeDeps()
    const config: Config = { checks: [{ ...pmd, when: "task-end" }, architecture] }

    await runTaskEndChecks("/repo", config, deps)

    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toEqual([
      { when: "task-end", check: "pmd", report: "maven", result: "passed", durationMs: expect.any(Number) },
      { when: "task-end", check: "architecture", report: "archunit", result: "passed", durationMs: expect.any(Number) },
    ])
  })

  it("records each violation's rule, type and file, and neither its message nor its line", async () => {
    const { deps, recorded } = fakeDeps(PMD_FAILURE)

    await runEditChecks("/repo", { checks: [pmd] }, ["src/main/java/shop/Order.java"], deps)

    const [metric] = recorded[0] ?? []
    expect(metric?.result).toBe("violations")
    // At edit a PMD check shows only the failures of the changed files: the metric keeps what the agent was shown.
    expect(metric?.violations).toEqual([{ rule: "EmptyCatchBlock", type: "pmd", file: "src/main/java/shop/Order.java" }])
    expect(JSON.stringify(recorded)).not.toContain("Avoid empty catch blocks")
  })

  it("records a check that waits for more edits as skipped, not as passed", async () => {
    const { deps, recorded } = fakeDeps()

    await runEditChecks("/repo", { checks: [{ ...pmd, every: 3 }] }, ["src/main/java/shop/Order.java"], deps)

    expect(recorded[0]).toEqual([{ when: "edit", check: "pmd", report: "maven", result: "skipped", skipped: "pending", durationMs: 0 }])
  })

  it("records the checks of a project that did not change since they passed as skipped at the agent's task end", async () => {
    const { deps, recorded } = fakeDeps(PASSING, { changed: false })

    await runTaskEndChecks("/repo", { checks: [architecture] }, deps, { changedOnly: true })

    expect(recorded[0]).toEqual([
      { when: "task-end", check: "architecture", report: "archunit", result: "skipped", skipped: "unchanged", durationMs: 0 },
    ])
  })

  it("records a check that passed on the reports of an earlier build as skipped", async () => {
    const { deps, recorded } = fakeDeps(PASSING, { fresh: true })

    const outcomes = await runTaskEndChecks("/repo", { checks: [architecture] }, deps, { changedOnly: true })

    expect(outcomes[0]?.status).toBe("passed")
    expect(recorded[0]?.[0]).toMatchObject({ result: "skipped", skipped: "build" })
  })

  it("keeps who ran the checks", async () => {
    const { deps, recorded } = fakeDeps()
    const agent = { agent: "opencode", session: "ses_1", subagent: true as const, agentType: "explore", model: "gpt-4.1", provider: "openai" }

    await runTaskEndChecks("/repo", { checks: [architecture] }, deps, { agent })

    expect(recorded[0]?.[0]).toMatchObject(agent)
  })

  it("records nothing with metrics: false", async () => {
    const { deps, recorded } = fakeDeps(PMD_FAILURE)

    await runEditChecks("/repo", { checks: [pmd], metrics: false }, ["src/main/java/shop/Order.java"], deps)
    await runTaskEndChecks("/repo", { checks: [architecture], metrics: false }, deps)

    expect(recorded).toEqual([])
  })

  it("gives the same outcomes when the metrics cannot be kept", async () => {
    const { deps } = fakeDeps(PMD_FAILURE)
    const failing: CheckDeps = {
      ...deps,
      metrics: () => {
        throw new Error("disk full")
      },
    }

    const kept = await runEditChecks("/repo", { checks: [pmd] }, ["src/main/java/shop/Order.java"], deps)
    const lost = await runEditChecks("/repo", { checks: [pmd] }, ["src/main/java/shop/Order.java"], failing)

    expect(lost).toEqual(kept)
  })
})

describe("fileMetrics", () => {
  let stateDir: string
  let projectDir: string

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "interlint-metrics-"))
    projectDir = mkdtempSync(join(tmpdir(), "interlint-metrics-project-"))
  })

  afterEach(() => {
    for (const dir of [stateDir, projectDir]) rmSync(dir, { recursive: true, force: true })
  })

  const metric: CheckMetric = { when: "edit", check: "pmd", report: "maven", result: "passed", durationMs: 12 }
  const at = new Date("2026-11-05T10:20:30.000Z")

  function lines(file: string): unknown[] {
    return readFileSync(file, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line))
  }

  it("appends one line for each metric to the project's file of the month", () => {
    const sink = fileMetrics(stateDir, () => at)

    sink(projectDir, [metric, { ...metric, check: "checkstyle" }])
    sink(projectDir, [metric])

    const file = join(stateDir, projectKey(projectDir), "2026-11.jsonl")
    const version = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")).version
    expect(lines(file)).toEqual([
      { v: 1, at: "2026-11-05T10:20:30.000Z", interlint: version, projectKey: projectKey(projectDir), project: basename(projectDir), ...metric },
      expect.objectContaining({ check: "checkstyle" }),
      expect.objectContaining({ check: "pmd" }),
    ])
  })

  it("starts a new file each month and keeps the old one", () => {
    fileMetrics(stateDir, () => at)(projectDir, [metric])
    fileMetrics(stateDir, () => new Date("2026-12-01T00:00:00.000Z"))(projectDir, [metric])

    expect(readdirSync(join(stateDir, projectKey(projectDir))).sort()).toEqual(["2026-11.jsonl", "2026-12.jsonl"])
  })

  it("keeps the folder name of the project, never its path", () => {
    fileMetrics(stateDir, () => at)(projectDir, [metric])

    const text = readFileSync(join(stateDir, projectKey(projectDir), "2026-11.jsonl"), "utf8")
    expect(text).not.toContain(JSON.stringify(projectDir).slice(1, -1))
  })

  it("writes nothing and does not throw when the state directory cannot be written", () => {
    const blocked = join(stateDir, "a-file")
    writeFileSync(blocked, "")

    expect(() => fileMetrics(blocked, () => at)(projectDir, [metric])).not.toThrow()
  })

  it("writes nothing for a run without metrics", () => {
    fileMetrics(stateDir, () => at)(projectDir, [])

    expect(readdirSync(stateDir)).toEqual([])
  })
})
