import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fileMetrics } from "../src/adapters/driven/state/file-metrics.js"
import { projectKey } from "../src/adapters/driven/state/user-state.js"
import type { CheckMetric } from "../src/domain/metric.js"
import { main } from "../src/main.js"

let projectDir: string
let stateDir: string

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "interlint-metrics-cmd-"))
  stateDir = mkdtempSync(join(tmpdir(), "interlint-metrics-cmd-state-"))
  vi.stubEnv("LOCALAPPDATA", stateDir)
  vi.stubEnv("XDG_STATE_HOME", stateDir)
})

afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of [projectDir, stateDir]) rmSync(dir, { recursive: true, force: true })
})

const metricsRoot = () => join(stateDir, "interlint", "metrics")

/** Keeps one run of checks of `dir` as `interlint check` would, at `at`. */
function keep(at: string, metrics: CheckMetric[], dir = projectDir) {
  fileMetrics(metricsRoot(), () => new Date(at))(dir, metrics)
}

async function run(...args: string[]) {
  let stdout = ""
  let stderr = ""
  const exitCode = await main(["metrics", ...args, "--cwd", projectDir], {
    cwd: projectDir,
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  })
  return { exitCode, stdout, stderr }
}

const claude = { agent: "claude-code", session: "s-1", model: "claude-opus-5-5" }

/** A failed task end, its fix, edits with six rules, and a check run by hand. */
function keepSession() {
  const rules = ["LineLength", "MissingJavadocMethod", "EmptyCatchBlock", "MagicNumber", "FinalClass", "NeedBraces"]
  keep("2026-11-05T10:00:00.000Z", [
    {
      when: "edit",
      check: "checkstyle",
      report: "maven",
      result: "violations",
      durationMs: 1500,
      // LineLength six times, the next rules fewer and fewer: NeedBraces once.
      violations: rules.flatMap((rule, index) => Array.from({ length: 6 - index }, () => ({ rule, type: "checkstyle" as const }))),
      ...claude,
    },
  ])
  keep("2026-11-05T10:05:00.000Z", [
    {
      when: "task-end",
      check: "architecture",
      report: "archunit",
      result: "violations",
      durationMs: 9000,
      violations: [{ rule: "ARCH-01", type: "architecture" }],
      ...claude,
    },
    { when: "task-end", check: "checkstyle", report: "maven", result: "skipped", skipped: "build", durationMs: 0, ...claude },
  ])
  keep("2026-11-05T10:09:00.000Z", [
    { when: "task-end", check: "architecture", report: "archunit", result: "passed", durationMs: 8500, ...claude },
  ])
  keep("2026-11-06T08:00:00.000Z", [
    {
      when: "task-end",
      check: "pmd",
      report: "maven",
      result: "violations",
      durationMs: 1000,
      violations: [{ rule: "UnusedPrivateField", type: "pmd" }, { rule: "UnusedPrivateField", type: "pmd" }],
    },
  ])
}

describe("interlint metrics", () => {
  it("shows the checks, violations by type, top 5 rules, models, agents, sessions, blocks and time", async () => {
    keepSession()

    const { exitCode, stdout } = await run()

    expect(exitCode).toBe(0)
    expect(stdout).toContain("2026-11-05 to 2026-11-06")
    expect(stdout).toContain("Checks run: 4 (1 skipped) · violations: 24")
    expect(stdout).toContain("By type: checkstyle 21 · pmd 2 · architecture 1")
    expect(stdout).toMatch(/Top rules:\n {2}6 {2}checkstyle {2}LineLength\n {2}5 {2}checkstyle {2}MissingJavadocMethod\n/)
    expect(stdout).toContain("FinalClass")
    expect(stdout).not.toContain("NeedBraces")
    expect(stdout).toMatch(/claude-opus-5-5 +7\.33 +\(3 checks, 1 session\)/)
    expect(stdout).toMatch(/unknown +2\.00 +\(1 check, 0 sessions\)/)
    expect(stdout).toMatch(/claude-code +7\.33 +\(3 checks, 1 session\)/)
    expect(stdout).toMatch(/manual +2\.00 +\(1 check, 0 sessions\)/)
    expect(stdout).toContain("Sessions: 1, 3.0 checks run on average, 3 at most")
    expect(stdout).toContain("Task-end blocks: 1, 1 fixed later in the session")
    expect(stdout).toContain("Time spent on checks: 20.0s")
  })

  it("says there are no metrics yet, and where they are kept, and exits with 0", async () => {
    const { exitCode, stdout } = await run()

    expect(exitCode).toBe(0)
    expect(stdout).toBe(`No metrics yet. Interlint keeps them in ${join(metricsRoot(), projectKey(projectDir))}.\n`)
  })

  it("skips lines that are not events, says how many, and shows the rest", async () => {
    keepSession()
    const dir = join(metricsRoot(), projectKey(projectDir))
    writeFileSync(join(dir, "2026-11.jsonl"), `${readFileSync(join(dir, "2026-11.jsonl"), "utf8")}edited\n{"v":1}\n`)

    const { exitCode, stdout } = await run()

    expect(exitCode).toBe(0)
    expect(stdout).toContain("Checks run: 4 (1 skipped)")
    expect(stdout).toContain("Skipped 2 lines that are not metrics events.")
  })

  it("keeps the events from a day on with --since, and those of one agent with --agent", async () => {
    keepSession()

    expect((await run("--since", "2026-11-06")).stdout).toContain("Checks run: 1 (0 skipped) · violations: 2")
    expect((await run("--agent", "claude-code")).stdout).toContain("Checks run: 3 (1 skipped) · violations: 22")
    expect((await run("--agent", "opencode")).stdout).toBe("No metrics match --agent opencode.\n")
  })

  it("shows the current project only, and every project with --all", async () => {
    const other = mkdtempSync(join(tmpdir(), "interlint-metrics-cmd-other-"))
    try {
      keep("2026-11-05T10:00:00.000Z", [{ when: "edit", check: "pmd", report: "maven", result: "passed", durationMs: 1 }])
      keep("2026-11-05T10:00:00.000Z", [{ when: "edit", check: "pmd", report: "maven", result: "passed", durationMs: 1 }], other)

      expect((await run()).stdout).toContain("Checks run: 1 ")
      const all = await run("--all")
      expect(all.stdout).toContain("Checks run: 2 ")
      expect(all.stdout).toContain("2 projects")
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it.each([
    [["--since", "yesterday"], '--since must be a date as YYYY-MM-DD (got "yesterday")'],
    [["--since", "2026-02-30"], '--since must be a date as YYYY-MM-DD (got "2026-02-30")'],
    [["--agent", "cursor"], '--agent must be claude-code or opencode (got "cursor")'],
    [["--out", "x.md"], "--out is only valid with metrics report"],
    [["--force"], "--force is only valid with metrics report"],
    [["export"], 'unknown metrics command "export"'],
  ])("rejects %j with exit code 2", async (args, message) => {
    const { exitCode, stderr } = await run(...args)

    expect(exitCode).toBe(2)
    expect(stderr).toContain(message)
  })
})

describe("interlint metrics report", () => {
  it("writes every section to interlint-metrics.md in the project and says where", async () => {
    keepSession()

    const { exitCode, stdout } = await run("report")

    const path = join(projectDir, "interlint-metrics.md")
    expect(exitCode).toBe(0)
    expect(stdout).toBe(`Wrote the metrics report to ${path}\n`)
    const report = readFileSync(path, "utf8")
    for (const heading of [
      "# Interlint metrics",
      "## Totals",
      "## Violations by type",
      "## Top 20 rules",
      "## By model",
      "## By agent",
      "## Sessions",
      "## Task-end blocks",
      "## Time spent on checks",
      "## Over time",
    ]) {
      expect(`\n${report}`).toContain(`\n${heading}\n`)
    }
    expect(report).toContain("| 6 | checkstyle | LineLength |")
    expect(report).toContain("| NeedBraces |")
    expect(report).toContain("| claude-opus-5-5 | 1 | 3 | 22 | 7.33 |")
    expect(report).toContain("| unknown | 0 | 1 | 2 | 2.00 |")
    expect(report).toContain("| s-1 | claude-code | claude-opus-5-5 | 3 | 22 | 1 | 1 | yes |")
    expect(report).toContain("| claude-opus-5-5 | 1 | 1 | 100% |")
    expect(report).toContain("| architecture | task-end | 2 | 17.5s | 8.8s |")
    expect(report).toContain("| 2026-11-02 | 4 | 24 |")
  })

  it("draws Mermaid charts that GitHub shows: types, rules, failed checks and violations per check by model, time and weeks", async () => {
    keepSession()

    await run("report")

    const report = readFileSync(join(projectDir, "interlint-metrics.md"), "utf8")
    expect(report).toContain(
      [
        "## Violations by type",
        "",
        "```mermaid",
        "xychart-beta",
        '    title "Violations by type"',
        '    x-axis ["checkstyle", "pmd", "architecture"]',
        '    y-axis "Violations"',
        "    bar [21, 2, 1]",
        "```",
        "",
        "| Type | Violations |",
      ].join("\n"),
    )
    expect(report).toContain(
      [
        "```mermaid",
        "xychart-beta horizontal",
        '    title "Top 10 rules"',
        '    x-axis ["LineLength", "MissingJavadocMethod", "EmptyCatchBlock", "MagicNumber", "FinalClass", "UnusedPrivateField", "NeedBraces", "ARCH-01"]',
        '    y-axis "Violations"',
        "    bar [6, 5, 4, 3, 2, 2, 1, 1]",
        "```",
      ].join("\n"),
    )
    expect(report).toContain(
      [
        "## By model",
        "",
        "```mermaid",
        "pie showData",
        "    title Failed checks by model",
        '    "claude-opus-5-5 (3 checks, 1 session)" : 2',
        '    "unknown (1 check, 0 sessions)" : 1',
        "```",
        "",
        "```mermaid",
        "xychart-beta",
        '    title "Violations per check run by model"',
        '    x-axis ["claude-opus-5-5", "unknown"]',
        '    y-axis "Violations per check run"',
        "    bar [7.33, 2]",
        "```",
      ].join("\n"),
    )
    expect(report).toContain(
      [
        '    title "Time spent on checks (seconds)"',
        '    x-axis ["architecture task-end", "checkstyle edit", "pmd task-end"]',
        '    y-axis "Seconds"',
        "    bar [17.5, 1.5, 1]",
      ].join("\n"),
    )
    expect(report).toContain(
      [
        '    title "Checks run (bars) and violations (line) per week"',
        '    x-axis ["2026-11-02"]',
        '    y-axis "Checks and violations"',
        "    bar [4]",
        "    line [24]",
      ].join("\n"),
    )
  })

  it("draws no chart that would be empty", async () => {
    keep("2026-11-05T10:00:00.000Z", [{ when: "edit", check: "pmd", report: "maven", result: "passed", durationMs: 1000 }])

    await run("report")

    const report = readFileSync(join(projectDir, "interlint-metrics.md"), "utf8")
    expect(report).not.toContain('title "Violations by type"')
    expect(report).not.toContain('title "Top 10 rules"')
    expect(report).not.toContain("pie showData")
    expect(report).toContain('title "Time spent on checks (seconds)"')
  })

  it("writes to the path --out gives, from the current directory", async () => {
    keepSession()

    const { exitCode } = await run("report", "--out", "out/metrics.md")

    expect(exitCode).toBe(0)
    expect(readFileSync(join(projectDir, "out", "metrics.md"), "utf8")).toContain("# Interlint metrics")
  })

  it("never replaces an existing file without --force", async () => {
    keepSession()
    const path = join(projectDir, "interlint-metrics.md")
    writeFileSync(path, "mine")

    const refused = await run("report")

    expect(refused.exitCode).toBe(2)
    expect(refused.stderr).toContain(`${path} already exists. Use --force to replace it.`)
    expect(readFileSync(path, "utf8")).toBe("mine")

    expect((await run("report", "--force")).exitCode).toBe(0)
    expect(readFileSync(path, "utf8")).toContain("# Interlint metrics")
  })

  it("writes nothing when there are no metrics", async () => {
    const { exitCode, stdout } = await run("report")

    expect(exitCode).toBe(0)
    expect(stdout).toContain("No metrics yet.")
    expect(existsSync(join(projectDir, "interlint-metrics.md"))).toBe(false)
  })

  it("says how many lines it skipped", async () => {
    keepSession()
    const dir = join(metricsRoot(), projectKey(projectDir))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "2026-10.jsonl"), "edited\n")

    const { stdout } = await run("report")

    expect(stdout).toContain("Skipped 1 line that is not a metrics event.")
    expect(readFileSync(join(projectDir, "interlint-metrics.md"), "utf8")).toContain("Skipped 1 line that is not a metrics event.")
  })
})

describe("interlint metrics report --format html", () => {
  it("writes one HTML file with the same sections, SVG charts and the main figures, and says where", async () => {
    keepSession()

    const { exitCode, stdout } = await run("report", "--format", "html")

    const path = join(projectDir, "interlint-metrics.html")
    expect(exitCode).toBe(0)
    expect(stdout).toBe(`Wrote the metrics report to ${path}\n`)
    const html = readFileSync(path, "utf8")
    expect(html.startsWith("<!doctype html>")).toBe(true)
    for (const heading of ["Totals", "Violations by type", "Top 20 rules", "By model", "By agent", "Sessions", "Task-end blocks", "Time spent on checks", "Over time"]) {
      expect(html).toContain(`<h2>${heading}</h2>`)
    }
    expect(html.match(/<svg /g)).toHaveLength(6)
    expect(html).toContain("<title>Failed checks by model</title>")
    expect(html).toContain("claude-opus-5-5 (3 checks, 1 session) · 2 (67%)")
    expect(html).toContain("unknown (1 check, 0 sessions) · 1 (33%)")
    expect(html).toContain("<strong>4</strong><span>Checks run</span>")
    expect(html).toContain("<strong>24</strong><span>Violations</span>")
    expect(html).toContain("<strong>1 of 1</strong><span>Task-end blocks fixed</span>")
    expect(html).toContain("@media print")
    expect(html).not.toMatch(/<script|<link|src="http/)
  })

  it("escapes what the metrics hold, such as a rule name with markup", async () => {
    keep("2026-11-05T10:00:00.000Z", [
      {
        when: "edit",
        check: "architecture",
        report: "archunit",
        result: "violations",
        durationMs: 1000,
        violations: [{ rule: "no <script> & List<String>", type: "architecture" }],
      },
    ])

    await run("report", "--format", "html")

    const html = readFileSync(join(projectDir, "interlint-metrics.html"), "utf8")
    expect(html).toContain("no &lt;script&gt; &amp; List&lt;String&gt;")
    expect(html).not.toContain("<script>")
  })

  it("takes --out and never replaces an existing file without --force", async () => {
    keepSession()
    const path = join(projectDir, "out", "team.html")
    mkdirSync(join(projectDir, "out"))
    writeFileSync(path, "mine")

    const refused = await run("report", "--format", "html", "--out", "out/team.html")

    expect(refused.exitCode).toBe(2)
    expect(refused.stderr).toContain(`${path} already exists. Use --force to replace it.`)
    expect(readFileSync(path, "utf8")).toBe("mine")
    expect((await run("report", "--format", "html", "--out", "out/team.html", "--force")).exitCode).toBe(0)
    expect(readFileSync(path, "utf8")).toContain("<h1>Metrics report</h1>")
  })

  it("writes nothing when there are no metrics", async () => {
    const { exitCode, stdout } = await run("report", "--format", "html")

    expect(exitCode).toBe(0)
    expect(stdout).toContain("No metrics yet.")
    expect(existsSync(join(projectDir, "interlint-metrics.html"))).toBe(false)
  })

  it.each([
    [["report", "--format", "docx"], '--format must be md, html or pdf (got "docx")'],
    [["--format", "html"], "--format is only valid with metrics report"],
  ])("rejects %j with exit code 2", async (args, message) => {
    const { exitCode, stderr } = await run(...args)

    expect(exitCode).toBe(2)
    expect(stderr).toContain(message)
  })

  it("writes Markdown with --format md, as with no --format", async () => {
    keepSession()

    await run("report", "--format", "md")

    expect(readFileSync(join(projectDir, "interlint-metrics.md"), "utf8")).toContain("# Interlint metrics")
  })
})

describe("the usage", () => {
  it("lists both metrics commands", async () => {
    let stdout = ""
    await main(["--help"], { cwd: projectDir, stdout: (text) => void (stdout += text), stderr: () => {} })

    expect(stdout).toContain("interlint metrics [--all] [--since <YYYY-MM-DD>] [--agent claude-code|opencode] [--cwd <dir>]")
    expect(stdout).toContain("interlint metrics report [--out <path>] [--force] [--format md|html|pdf]")
  })
})
