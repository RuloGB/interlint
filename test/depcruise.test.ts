import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { depcruiseReader, parseDepcruiseJson } from "../src/adapters/driven/depcruise/report-reader.js"
import { eslintReader } from "../src/adapters/driven/eslint/report-reader.js"
import { loadConfig } from "../src/adapters/driven/yaml-config/config.js"
import { formatOutcomes } from "../src/application/checking/format-outcomes.js"
import type { PendingEdit, ReportReader } from "../src/application/checking/ports.js"
import { type CheckDeps, runEditChecks, runTaskEndChecks } from "../src/application/checking/run-checks.js"
import { recordRun } from "../src/application/checking/check-metrics.js"
import { type Check, isSourceOf } from "../src/domain/check.js"
import { DEPCRUISE_COMMAND, DEPCRUISE_REPORT } from "../src/domain/depcruise-command.js"
import { ESLINT_COMMAND, ESLINT_REPORT } from "../src/domain/eslint-command.js"
import { type CheckMetric, metricEventOf } from "../src/domain/metric.js"
import { summarize } from "../src/domain/metric-summary.js"

const RUN = DEPCRUISE_COMMAND
const depcruiseEdit: Check = { name: "depcruise", run: RUN, report: "depcruise", when: "edit" }

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "interlint-depcruise-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

interface Violation {
  type: string
  from: string
  to: string
  rule: { name: string; severity: "error" | "warn" | "info" | "ignore" }
  cycle?: { name: string }[]
}

const domainToInfra: Violation = {
  type: "dependency",
  from: "src/domain/order.ts",
  to: "src/infrastructure/order-repository.ts",
  rule: { name: "domain-not-to-infrastructure", severity: "error" },
}
const orphan: Violation = {
  type: "module",
  from: "src/infrastructure/orphan.ts",
  to: "src/infrastructure/orphan.ts",
  rule: { name: "no-orphans", severity: "warn" },
}
const appToInfra: Violation = {
  type: "dependency",
  from: "src/application/place-order.ts",
  to: "src/infrastructure/order-repository.ts",
  rule: { name: "application-not-to-infrastructure", severity: "info" },
}

/** dependency-cruiser's JSON report, as `-T json` writes it, with the parts the reader uses. */
function report(
  violations: Violation[],
  options: { totalCruised?: number; comments?: Record<string, string>; issues?: string[] } = {},
) {
  const forbidden = Object.entries(options.comments ?? {}).map(([name, comment]) => ({ name, comment, severity: "error" }))
  return {
    modules: [],
    summary: {
      violations,
      error: violations.filter((violation) => violation.rule.severity === "error").length,
      totalCruised: options.totalCruised ?? 4,
      ruleSetUsed: { forbidden },
      ...(options.issues === undefined
        ? {}
        : { environment: { issues: options.issues.map((name) => ({ name, severity: "warn", description: name })) } }),
    },
  }
}

function write(file: string, content = "") {
  const path = join(dir, ...file.split("/"))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

/** Writes dependency-cruiser's report where a run in `cwd` leaves it. */
function writeReport(content: unknown, cwd = dir) {
  const path = join(cwd, ...DEPCRUISE_REPORT.split("/"))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(content))
}

describe("parseDepcruiseJson", () => {
  it("gives a forbidden dependency with its rule, its source file and the module it imports", () => {
    const json = JSON.stringify(report([domainToInfra]))

    expect(parseDepcruiseJson(json)).toEqual({
      cruised: true,
      failures: [
        {
          title: "domain-not-to-infrastructure",
          type: "architecture",
          violations: [
            {
              text: "src/domain/order.ts depends on src/infrastructure/order-repository.ts",
              file: "order.ts",
              path: "src/domain/order.ts",
            },
          ],
        },
      ],
    })
  })

  it("adds the rule's comment to its title", () => {
    const json = JSON.stringify(report([domainToInfra], { comments: { "domain-not-to-infrastructure": "domain stays pure" } }))

    expect(parseDepcruiseJson(json).failures.map((failure) => failure.title)).toEqual([
      "domain-not-to-infrastructure: domain stays pure",
    ])
  })

  it("leaves out the violations the project accepts (warn, info)", () => {
    const json = JSON.stringify(report([orphan, appToInfra]))

    expect(parseDepcruiseJson(json)).toEqual({ cruised: true, failures: [] })
  })

  it("names a module rule by the module alone, and a cycle by its path", () => {
    const moduleRule: Violation = { ...orphan, rule: { name: "no-orphans", severity: "error" } }
    const cycle: Violation = {
      type: "cycle",
      from: "src/a.ts",
      to: "src/b.ts",
      rule: { name: "no-circular", severity: "error" },
      cycle: [{ name: "src/b.ts" }, { name: "src/a.ts" }],
    }

    const texts = parseDepcruiseJson(JSON.stringify(report([moduleRule, cycle]))).failures.map(
      (failure) => failure.violations[0]?.text,
    )

    expect(texts).toEqual(["Module src/infrastructure/orphan.ts", "src/a.ts depends on src/b.ts (cycle: src/a.ts → src/b.ts → src/a.ts)"])
  })

  it("names the other modules of a cycle, so an edit of any of them shows it", () => {
    const cycle: Violation = {
      type: "cycle",
      from: "src/a.ts",
      to: "src/b.ts",
      rule: { name: "no-circular", severity: "error" },
      cycle: [{ name: "src/b.ts" }, { name: "src/c.ts" }, { name: "src/a.ts" }],
    }

    const [violation] = parseDepcruiseJson(JSON.stringify(report([cycle]))).failures[0]?.violations ?? []

    expect(violation).toMatchObject({ path: "src/a.ts", related: ["src/b.ts", "src/c.ts"] })
  })

  it("groups the violations of one rule", () => {
    const other = { ...domainToInfra, from: "src/domain/invoice.ts" }

    const failures = parseDepcruiseJson(JSON.stringify(report([domainToInfra, other]))).failures

    expect(failures).toHaveLength(1)
    expect(failures[0]?.violations.map((violation) => violation.path)).toEqual(["src/domain/order.ts", "src/domain/invoice.ts"])
  })

  it("tells a run that analyzed no module, as with a TypeScript it does not support", () => {
    expect(parseDepcruiseJson(JSON.stringify(report([], { totalCruised: 0 })))).toEqual({ cruised: false, failures: [] })
  })

  it("tells a run without a TypeScript compiler it supports, which analyzes only the JavaScript files", () => {
    const json = JSON.stringify(report([], { totalCruised: 1, issues: ["missing-typescript-transpiler"] }))

    expect(parseDepcruiseJson(json)).toEqual({ cruised: false, failures: [] })
  })

  it("gives nothing for a report that is not dependency-cruiser's JSON", () => {
    expect(parseDepcruiseJson("not json")).toEqual({ cruised: false, failures: [] })
    expect(parseDepcruiseJson("[]")).toEqual({ cruised: false, failures: [] })
  })
})

describe("depcruiseReader", () => {
  it("creates the report's directory before the run, since dependency-cruiser does not", () => {
    mkdirSync(join(dir, "node_modules"))

    depcruiseReader.snapshot(dir)

    expect(existsSync(dirname(join(dir, ...DEPCRUISE_REPORT.split("/"))))).toBe(true)
  })

  it("creates the report's directory without a node_modules of the project's own, as in a hoisted npm workspace", () => {
    depcruiseReader.snapshot(dir)

    expect(existsSync(dirname(join(dir, ...DEPCRUISE_REPORT.split("/"))))).toBe(true)
  })

  it("reads a report the run rewrote with the same size and time as the earlier one", () => {
    const path = join(dir, ...DEPCRUISE_REPORT.split("/"))
    const content = report([domainToInfra])
    const time = new Date("2026-11-13T10:00:00.000Z")
    writeReport(content)
    utimesSync(path, time, time)
    const before = depcruiseReader.snapshot(dir)
    writeReport(content)
    utimesSync(path, time, time)

    expect(depcruiseReader.read(dir, before, "")).toMatchObject({ found: true, failures: [{ title: "domain-not-to-infrastructure" }] })
  })

  it("reads the report the run wrote", () => {
    const before = depcruiseReader.snapshot(dir)
    writeReport(report([domainToInfra]))

    expect(depcruiseReader.read(dir, before, "")).toMatchObject({ found: true, failures: [{ title: "domain-not-to-infrastructure" }] })
  })

  it("ignores a report left by an earlier run", () => {
    writeReport(report([domainToInfra]))
    const before = depcruiseReader.snapshot(dir)

    expect(depcruiseReader.read(dir, before, "")).toEqual({ found: false, failures: [] })
  })

  it("finds no report when the run analyzed no module", () => {
    const before = depcruiseReader.snapshot(dir)
    writeReport(report([], { totalCruised: 0 }))

    expect(depcruiseReader.read(dir, before, "")).toEqual({ found: false, failures: [] })
  })
})

describe("sources of report: depcruise", () => {
  it("are the TypeScript and JavaScript files", () => {
    for (const file of ["src/a.ts", "src/a.tsx", "src/a.mts", "src/a.cts", "src/a.js", "src/a.jsx", "src/a.mjs", "src/a.cjs"]) {
      expect(isSourceOf("depcruise", file)).toBe(true)
    }
    expect(isSourceOf("depcruise", "README.md")).toBe(false)
  })
})

/** What a fake run of dependency-cruiser leaves: its report, or none, and how it exits. */
interface FakeRun {
  exitCode: number
  report?: unknown
  output?: string
}

/** The real reader, with a command runner that writes the report dependency-cruiser would. */
function depcruiseDeps(fake: FakeRun) {
  const launched: string[] = []
  const saved = new Map<string, PendingEdit[]>()
  const unused: ReportReader = { snapshot: () => new Map(), read: () => ({ found: true, failures: [] }) }
  const deps: CheckDeps = {
    run: async (command, cwd) => {
      launched.push(command)
      if (fake.report !== undefined) writeReport(fake.report, cwd)
      return { exitCode: fake.exitCode, output: fake.output ?? "" }
    },
    readers: { archunit: unused, maven: unused, jacoco: unused, eslint: unused, depcruise: depcruiseReader },
    hasExecutable: () => false,
    lock: (_projectDir, work) => work(),
    changes: {
      lookup: () => ({ changed: true, record: undefined, fingerprint: "", lastModifiedMs: 0 }),
      accept: () => {},
      touch: () => {},
    },
    hasDirectory: () => true,
    editScopes: {},
    removeBrokenClasses: () => [],
    pending: {
      list: (projectDir, check) => saved.get(`${projectDir}|${check}`) ?? [],
      save: (projectDir, check, edits) => (saved.set(`${projectDir}|${check}`, edits), true),
    },
    metrics: () => {},
  }
  return { deps, launched }
}

describe("a depcruise check at edit", () => {
  it("analyzes the whole project and shows only the violations of the edited file", async () => {
    const other = { ...domainToInfra, from: "src/domain/invoice.ts" }
    const { deps, launched } = depcruiseDeps({ exitCode: 0, report: report([domainToInfra, other]) })

    const outcomes = await runEditChecks(dir, { checks: [depcruiseEdit] }, ["src/domain/order.ts"], deps)

    expect(launched).toEqual([RUN])
    expect(formatOutcomes(outcomes)).toBe(
      [
        "✗ depcruise · domain-not-to-infrastructure",
        "",
        "  src/domain/order.ts depends on src/infrastructure/order-repository.ts",
        "    at src/domain/order.ts",
        "",
        "Fix these problems before continuing.",
        "",
      ].join("\n"),
    )
  })

  it("does not run for a file that is not one of its sources", async () => {
    const { deps, launched } = depcruiseDeps({ exitCode: 0, report: report([domainToInfra]) })

    expect(await runEditChecks(dir, { checks: [depcruiseEdit] }, ["README.md"], deps)).toEqual([])
    expect(launched).toEqual([])
  })

  it("passes when the violations are all in files the edit did not change", async () => {
    const { deps } = depcruiseDeps({ exitCode: 0, report: report([domainToInfra]) })

    const outcomes = await runEditChecks(dir, { checks: [depcruiseEdit] }, ["src/application/place-order.ts"], deps)

    expect(outcomes.map((outcome) => outcome.status)).toEqual(["passed"])
  })

  it("shows a cycle after an edit of any of its modules, not only the one dependency-cruiser names", async () => {
    const cycle: Violation = {
      type: "cycle",
      from: "src/a.ts",
      to: "src/b.ts",
      rule: { name: "no-circular", severity: "error" },
      cycle: [{ name: "src/b.ts" }, { name: "src/a.ts" }],
    }
    const web: Check = { ...depcruiseEdit, name: "web/depcruise", dir: "web" }
    const { deps } = depcruiseDeps({ exitCode: 0, report: report([cycle]) })

    const outcomes = await runEditChecks(dir, { checks: [web] }, ["web/src/b.ts"], deps)

    expect(formatOutcomes(outcomes)).toContain("✗ web/depcruise · no-circular")
    expect(formatOutcomes(outcomes)).toContain("    at web/src/a.ts")
  })

  it("gives the paths from interlint.yaml in a project of a workspace", async () => {
    const web: Check = { ...depcruiseEdit, name: "web/depcruise", dir: "web" }
    const { deps } = depcruiseDeps({ exitCode: 0, report: report([domainToInfra]) })

    const outcomes = await runEditChecks(dir, { checks: [web] }, ["web/src/domain/order.ts"], deps)

    expect(formatOutcomes(outcomes)).toContain("    at web/src/domain/order.ts")
  })
})

describe("a depcruise check at task end", () => {
  it("analyzes the whole project and fails on a violation of severity error, though the command exits 0", async () => {
    const { deps, launched } = depcruiseDeps({ exitCode: 0, report: report([domainToInfra, orphan]) })

    const outcomes = await runTaskEndChecks(dir, { checks: [depcruiseEdit] }, deps)

    expect(launched).toEqual([RUN])
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["violations"])
    expect(formatOutcomes(outcomes)).not.toContain("no-orphans")
  })

  it("passes, and shows nothing, with violations the project accepts", async () => {
    const { deps } = depcruiseDeps({ exitCode: 0, report: report([orphan, appToInfra]) })

    const outcomes = await runTaskEndChecks(dir, { checks: [depcruiseEdit] }, deps)

    expect(outcomes.map((outcome) => outcome.status)).toEqual(["passed"])
    expect(formatOutcomes(outcomes)).toBe("")
  })

  it("shows dependency-cruiser's output, not a rule, when its configuration is broken", async () => {
    const { deps } = depcruiseDeps({
      exitCode: 1,
      output: "\n  ERROR: The supplied configuration is not valid: data/forbidden/0 must have required property 'from'\n",
    })

    const outcomes = await runTaskEndChecks(dir, { checks: [depcruiseEdit] }, deps)

    expect(outcomes.map((outcome) => outcome.status)).toEqual(["failed"])
    const text = formatOutcomes(outcomes)
    expect(text).toContain("✗ depcruise · the command failed (exit code 1) and left no dependency-cruiser failures")
    expect(text).toContain("ERROR: The supplied configuration is not valid")
  })

  it("shows the output when the dependencies are not installed, even with the report of an earlier run", async () => {
    writeReport(report([domainToInfra]))
    const { deps } = depcruiseDeps({ exitCode: 1, output: "npm error npx canceled due to missing packages" })

    const outcomes = await runTaskEndChecks(dir, { checks: [depcruiseEdit] }, deps)

    expect(outcomes.map((outcome) => outcome.status)).toEqual(["failed"])
  })

  it("fails when dependency-cruiser analyzed no module", async () => {
    const { deps } = depcruiseDeps({ exitCode: 0, report: report([], { totalCruised: 0 }) })

    const outcomes = await runTaskEndChecks(dir, { checks: [depcruiseEdit] }, deps)

    expect(formatOutcomes(outcomes)).toContain(
      "✗ depcruise · the command exited 0 but dependency-cruiser analyzed no source: it found no module, or no TypeScript compiler it supports",
    )
  })
})

describe("a project with an eslint and a depcruise check", () => {
  it("shows a failure of each tool in its own check", async () => {
    const eslint: Check = { name: "eslint", run: ESLINT_COMMAND, report: "eslint", when: "edit" }
    const { deps } = depcruiseDeps({ exitCode: 0 })
    deps.readers.eslint = eslintReader
    deps.run = async (command, cwd) => {
      if (command.includes(" eslint ")) {
        const path = join(cwd, ...ESLINT_REPORT.split("/"))
        mkdirSync(dirname(path), { recursive: true })
        const messages = [{ ruleId: "no-var", severity: 2, message: "Unexpected var, use let or const instead.", line: 3 }]
        writeFileSync(path, JSON.stringify([{ filePath: join(cwd, "src", "domain", "order.ts"), messages }]))
        return { exitCode: 1, output: "" }
      }
      writeReport(report([domainToInfra]), cwd)
      return { exitCode: 0, output: "" }
    }

    const text = formatOutcomes(await runEditChecks(dir, { checks: [eslint, depcruiseEdit] }, ["src/domain/order.ts"], deps))

    expect(text).toContain("✗ eslint · no-var\n\n  Unexpected var, use let or const instead.\n    at src/domain/order.ts:3")
    expect(text).toContain(
      "✗ depcruise · domain-not-to-infrastructure\n\n  src/domain/order.ts depends on src/infrastructure/order-repository.ts",
    )
  })
})

describe("report: depcruise in interlint.yaml", () => {
  it("is a format a check can use, at edit and at task end", () => {
    write(
      "interlint.yaml",
      [
        "checks:",
        "  - name: depcruise",
        `    run: ${RUN}`,
        "    report: depcruise",
        "    when: edit",
        "  - name: depcruise-all",
        `    run: ${RUN}`,
        "    report: depcruise",
        "    when: task-end",
        "",
      ].join("\n"),
    )

    expect(loadConfig(dir).checks.map((check) => `${check.report} ${check.when}`)).toEqual([
      "depcruise edit",
      "depcruise task-end",
    ])
  })
})

describe("the metrics of a depcruise check", () => {
  it("count its violations as architecture rules, as ArchUnit's", async () => {
    const { deps } = depcruiseDeps({ exitCode: 0, report: report([domainToInfra]) })
    const outcomes = await runTaskEndChecks(dir, { checks: [depcruiseEdit] }, deps)

    let kept: CheckMetric[] = []
    const entries = outcomes.map((outcome) => ({ check: outcome.check, outcome }))
    recordRun(dir, { checks: [depcruiseEdit] }, "task-end", entries, undefined, (_projectDir, metrics) => {
      kept = metrics
    })
    const [metric] = kept
    const event = metricEventOf({ v: 1, at: "2026-11-13T10:00:00.000Z", interlint: "1.17.0", projectKey: "k", project: "web", ...metric })

    expect(event?.report).toBe("depcruise")
    const summary = summarize([event!])
    expect(summary.byType).toEqual([{ type: "architecture", violations: 1 }])
    expect(summary.rules).toEqual([{ rule: "domain-not-to-infrastructure", type: "architecture", violations: 1 }])
  })
})
