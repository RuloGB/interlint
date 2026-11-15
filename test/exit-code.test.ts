import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { exitCodeReader } from "../src/adapters/driven/process/exit-code-reader.js"
import type { MetricsSink } from "../src/application/checking/ports.js"
import { type CheckDeps, runTaskEndChecks } from "../src/application/checking/run-checks.js"
import type { Check } from "../src/domain/check.js"
import { outputTail } from "../src/domain/command-output.js"
import type { CheckMetric } from "../src/domain/metric.js"
import { main } from "../src/main.js"

let projectDir: string
let stateDir: string

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "interlint-exit-code-"))
  stateDir = mkdtempSync(join(tmpdir(), "interlint-exit-code-state-"))
  vi.stubEnv("LOCALAPPDATA", stateDir)
  vi.stubEnv("XDG_STATE_HOME", stateDir)
})

afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of [projectDir, stateDir]) rmSync(dir, { recursive: true, force: true })
})

/** A team command: appends a line to `runs.txt` in the directory it runs in, prints `output` and exits. */
function command(name: string, options: { exitCode: number; output?: string; dir?: string }) {
  const dir = join(projectDir, options.dir ?? "")
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${name}.mjs`),
    `import { appendFileSync } from "node:fs"
appendFileSync("runs.txt", ${JSON.stringify(`${name}\n`)})
const output = ${JSON.stringify(options.output ?? "")}
if (output) console.log(output)
process.exit(${options.exitCode})
`,
  )
  return `node ${name}.mjs`
}

const runsIn = (dir = "") => {
  const path = join(projectDir, dir, "runs.txt")
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : []
}

interface CheckEntry {
  name: string
  run: string
  when?: string
  dir?: string
  every?: number
}

function writeConfig(...checks: CheckEntry[]) {
  const entries = checks.map(({ name, run, when = "task-end", dir, every }) =>
    [
      `  - name: ${name}`,
      `    run: ${run}`,
      "    report: exit-code",
      `    when: ${when}`,
      ...(dir === undefined ? [] : [`    dir: ${dir}`]),
      ...(every === undefined ? [] : [`    every: ${every}`]),
    ].join("\n"),
  )
  writeFileSync(join(projectDir, "interlint.yaml"), `checks:\n${entries.join("\n")}\n`)
}

async function run(...args: string[]) {
  let stdout = ""
  let stderr = ""
  const exitCode = await main(args, { cwd: projectDir, stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) })
  return { exitCode, stdout, stderr }
}

describe("a check with report: exit-code", () => {
  it("passes when its command exits 0", async () => {
    writeConfig({ name: "tests", run: command("tests", { exitCode: 0, output: "all good" }) })

    const { exitCode, stdout } = await run("check", "--when", "task-end")

    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^✓ Interlint · checks passed: tests \(\d+\.\ds\)\n$/)
  })

  it("fails when its command exits with another code, with the check name, the exit code and the last lines", async () => {
    const output = ["FAIL test/order.test.ts > totals", "AssertionError: expected 4 to be 3"].join("\n")
    writeConfig({ name: "tests", run: command("tests", { exitCode: 3, output }) })

    const { exitCode, stdout } = await run("check", "--when", "task-end")

    expect(exitCode).toBe(1)
    expect(stdout).toBe(
      [
        "✗ tests · the command failed (exit code 3)",
        "",
        "  Command: node tests.mjs",
        "  Last lines of its output:",
        "    FAIL test/order.test.ts > totals",
        "    AssertionError: expected 4 to be 3",
        "",
        "Fix these problems before continuing.",
        "",
      ].join("\n"),
    )
  })

  it("cuts the output to its last 60 lines and says it was cut", async () => {
    const output = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n")
    writeConfig({ name: "tests", run: command("tests", { exitCode: 1, output }) })

    const { stdout } = await run("check", "--when", "task-end")

    expect(stdout).toContain("  Last lines of its output:\n    … 40 earlier lines cut\n    line 41\n")
    expect(stdout).toContain("    line 100\n")
    expect(stdout).not.toContain("    line 40\n")
  })

  it("says so when the failing command printed nothing", async () => {
    writeConfig({ name: "tsc", run: command("tsc", { exitCode: 2 }) })

    const { stdout } = await run("check", "--when", "task-end")

    expect(stdout).toContain("✗ tsc · the command failed (exit code 2)\n\n  Command: node tsc.mjs\n  Last lines of its output:\n    (it printed nothing)\n")
  })

  it("gives a clear error, not a check failure, when its command does not exist", async () => {
    writeConfig({ name: "tests", run: "interlint-no-such-command-f24" })

    const { exitCode, stdout } = await run("check", "--when", "task-end")

    expect(exitCode).toBe(1)
    expect(stdout).toMatch(/^✗ tests · the command did not run: it was not found or could not start \(exit code \d+\)\n/)
    expect(stdout).toContain("  Command: interlint-no-such-command-f24\n")
    expect(stdout).not.toContain("the command failed")
  })

  it("fails the check when its command started and exited 127, as with a tool it runs that is missing", async () => {
    writeConfig({ name: "tests", run: command("tests", { exitCode: 127, output: "sh: 1: vitest: not found" }) })

    const { stdout } = await run("check", "--when", "task-end")

    expect(stdout).toContain("✗ tests · the command failed (exit code 127)\n")
    expect(stdout).toContain("    sh: 1: vitest: not found\n")
  })

  it("leaves the message of a check with a report alone when its command does not exist", async () => {
    writeFileSync(
      join(projectDir, "interlint.yaml"),
      "checks:\n  - name: architecture\n    run: interlint-no-such-command-f24\n    report: archunit\n    when: task-end\n",
    )

    const { stdout } = await run("check", "--when", "task-end")

    const exitCode = process.platform === "win32" ? 1 : 127
    expect(stdout).toContain(`✗ architecture · the command failed (exit code ${exitCode}) and left no ArchUnit failures\n`)
  })

  it("runs in its dir at task end", async () => {
    writeConfig({ name: "tests", run: command("tests", { exitCode: 0, dir: "web" }), dir: "web" })

    expect((await run("check", "--when", "task-end")).exitCode).toBe(0)
    expect(runsIn("web")).toEqual(["tests"])
  })

  it("runs at edit on a change of any file of its project", async () => {
    writeConfig({ name: "tests", run: command("tests", { exitCode: 1, output: "1 failed" }), when: "edit" })

    const { exitCode, stdout } = await run("check", "--when", "edit", "--file", "README.md")

    expect(exitCode).toBe(1)
    expect(stdout).toContain("✗ tests · the command failed (exit code 1)")
    expect(runsIn()).toEqual(["tests"])
  })

  it("does not run at edit on a change outside its dir", async () => {
    writeConfig({ name: "tests", run: command("tests", { exitCode: 1, dir: "web" }), when: "edit", dir: "web" })

    expect(await run("check", "--when", "edit", "--file", "api/Main.java")).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    expect(runsIn("web")).toEqual([])

    expect((await run("check", "--when", "edit", "--file", "web/src/order.ts")).exitCode).toBe(1)
    expect(runsIn("web")).toEqual(["tests"])
  })

  it("waits at edit for every distinct files", async () => {
    writeConfig({ name: "tests", run: command("tests", { exitCode: 0 }), when: "edit", every: 2 })

    await run("check", "--when", "edit", "--file", "src/a.ts")
    expect(runsIn()).toEqual([])

    expect((await run("check", "--when", "edit", "--file", "src/b.ts")).exitCode).toBe(0)
    expect(runsIn()).toEqual(["tests"])
  })
})

describe("exitCodeReader", () => {
  it("gives no result for a command that was not found, whatever its exit code", () => {
    expect(exitCodeReader.read("/repo", new Map(), "not found", { exitCode: 1, output: "not found", notFound: true })).toEqual({
      found: false,
      failures: [],
    })
  })

  it("reads nothing before a run", () => {
    expect(exitCodeReader.snapshot("/repo").size).toBe(0)
  })
})

describe("metrics of a check with report: exit-code", () => {
  const tests: Check = { name: "tests", run: "npm test", report: "exit-code", when: "task-end" }

  async function metricsOf(exitCode: number, notFound = false) {
    const recorded: CheckMetric[][] = []
    const metrics: MetricsSink = (_projectDir, run) => void recorded.push(run)
    const unused = { snapshot: () => new Map(), read: () => ({ found: true, failures: [] }) }
    const deps: CheckDeps = {
      run: async () => (notFound ? { exitCode, output: "not found", notFound: true } : { exitCode, output: "1 failed" }),
      readers: { archunit: unused, maven: unused, jacoco: unused, eslint: unused, depcruise: unused, "exit-code": exitCodeReader },
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
      pending: { list: () => [], save: () => true },
      metrics,
    }
    await runTaskEndChecks("/repo", { checks: [tests] }, deps, { agent: { agent: "claude-code", model: "opus" } })
    return recorded.flat()
  }

  it("keeps one failure per run, with the check name as its rule, and the agent", async () => {
    expect(await metricsOf(1)).toEqual([
      expect.objectContaining({
        check: "tests",
        report: "exit-code",
        result: "violations",
        violations: [{ rule: "tests" }],
        agent: "claude-code",
        model: "opus",
      }),
    ])
  })

  it("keeps a pass, and a command that did not start as failed", async () => {
    expect(await metricsOf(0)).toEqual([expect.objectContaining({ check: "tests", result: "passed" })])
    expect(await metricsOf(1, true)).toEqual([expect.objectContaining({ check: "tests", result: "failed" })])
  })
})

describe("outputTail", () => {
  it("counts the lines dropped before the output as cut", () => {

    expect(outputTail("a\nb\nc", 2, 500)).toBe("… 501 earlier lines cut\nb\nc")
    expect(outputTail("a\nb", 2, 3)).toBe("… 3 earlier lines cut\na\nb")
    expect(outputTail("a\nb", 2)).toBe("a\nb")
  })
})
