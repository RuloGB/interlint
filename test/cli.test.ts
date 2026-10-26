import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { lockFileFor } from "../src/adapters/lock/project-lock.js"
import { main } from "../src/cli.js"

const VIOLATIONS_XML = readFileSync(
  join(import.meta.dirname, "fixtures", "surefire", "two-rules-violated.xml"),
  "utf8",
)
const PASSING_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="ArchitectureRulesTest" tests="1"><testcase name="DOMAIN_IS_PURE" classname="ArchitectureRulesTest"/></testsuite>`

let projectDir: string
let stateDir: string

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "interlint-cli-"))
  // Interlint remembers which projects changed in the user's state directory.
  stateDir = mkdtempSync(join(tmpdir(), "interlint-cli-state-"))
  vi.stubEnv("LOCALAPPDATA", stateDir)
  vi.stubEnv("XDG_STATE_HOME", stateDir)
})

afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of [projectDir, stateDir]) rmSync(dir, { recursive: true, force: true })
})

/** A stand-in for Maven: writes a Surefire report (or not), prints some output and exits. */
function fakeCheck(script: string, options: { report?: string; exitCode: number; output?: string }) {
  writeFileSync(join(projectDir, `${script}.report.xml`), options.report ?? "")
  writeFileSync(
    join(projectDir, `${script}.mjs`),
    `import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
const report = readFileSync(${JSON.stringify(`${script}.report.xml`)}, "utf8")
if (report) {
  mkdirSync("target/surefire-reports", { recursive: true })
  writeFileSync("target/surefire-reports/TEST-${script}.xml", report)
}
console.log(${JSON.stringify(options.output ?? "")})
process.exit(${options.exitCode})
`,
  )
  return `node ${script}.mjs`
}

function writeConfig(...checks: { name: string; run: string; report?: string; when?: string }[]) {
  writeFileSync(
    join(projectDir, "interlint.yaml"),
    `checks:\n${checks
      .map(
        (check) =>
          `  - name: ${check.name}\n    run: ${check.run}\n    report: ${check.report ?? "archunit"}\n    when: ${check.when ?? "task-end"}\n`,
      )
      .join("")}`,
  )
}

async function run(...args: string[]) {
  let stdout = ""
  let stderr = ""
  const exitCode = await main(args, {
    cwd: projectDir,
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
  })
  return { exitCode, stdout, stderr }
}

describe("interlint check --when task-end", () => {
  it("prints nothing and exits 0 when every check passes", async () => {
    writeConfig({ name: "architecture", run: fakeCheck("arch", { report: PASSING_XML, exitCode: 0 }) })

    expect(await run("check", "--when", "task-end")).toEqual({ exitCode: 0, stdout: "", stderr: "" })
  })

  it("runs every check, including the edit ones", async () => {
    writeConfig(
      { name: "fast", run: fakeCheck("fast", { report: PASSING_XML, exitCode: 0 }), when: "edit" },
      { name: "slow", run: fakeCheck("slow", { report: VIOLATIONS_XML, exitCode: 1 }) },
    )

    const result = await run("check", "--when", "task-end")

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("✗ slow · ARCH-01: application has ZERO dependencies on infrastructure")
    expect(readFileSync(join(projectDir, "target", "surefire-reports", "TEST-fast.xml"), "utf8")).toBe(PASSING_XML)
  })

  it("prints the violated rules and exits 1", async () => {
    writeConfig({ name: "architecture", run: fakeCheck("arch", { report: VIOLATIONS_XML, exitCode: 1 }) })

    const { exitCode, stdout } = await run("check", "--when", "task-end")

    expect(exitCode).toBe(1)
    expect(stdout).toContain("✗ architecture · ARCH-01: application has ZERO dependencies on infrastructure\n")
    expect(stdout).toContain("✗ architecture · ARCH-01: domain depends on nothing outside domain (and domain exceptions)\n")
    expect(stdout).toContain("(Project.java:70)")
    expect(stdout).not.toContain("at com.tngtech.archunit")
  })

  it("defaults to task-end when --when is omitted", async () => {
    writeConfig({ name: "architecture", run: fakeCheck("arch", { report: VIOLATIONS_XML, exitCode: 1 }) })

    expect((await run("check")).exitCode).toBe(1)
  })

  it("reports a command that fails without a report, with a bounded tail of its output", async () => {
    const output = Array.from({ length: 100 }, (_, index) => `[ERROR] line ${index + 1}`).join("\n")
    writeConfig({ name: "architecture", run: fakeCheck("arch", { exitCode: 1, output }) })

    const { exitCode, stdout } = await run("check", "--when", "task-end")

    expect(exitCode).toBe(1)
    expect(stdout).toContain("✗ architecture · the command failed (exit code 1) and left no ArchUnit failures")
    expect(stdout).toContain("    [ERROR] line 100\n")
    expect(stdout).not.toContain("[ERROR] line 50\n")
  })

  it("fails when the command exits 0 but writes no ArchUnit report, so skipped tests never pass silently", async () => {
    writeConfig({ name: "architecture", run: fakeCheck("arch", { exitCode: 0, output: "[INFO] Tests are skipped." }) })

    const { exitCode, stdout } = await run("check")

    expect(exitCode).toBe(1)
    expect(stdout).toContain("✗ architecture · the command exited 0 but wrote no ArchUnit report")
    expect(stdout).toContain("    [INFO] Tests are skipped.\n")
  })

  it("ignores reports left by earlier runs", async () => {
    writeConfig({ name: "architecture", run: fakeCheck("arch", { report: VIOLATIONS_XML, exitCode: 1 }) })
    await run("check")
    writeConfig({ name: "architecture", run: fakeCheck("other", { report: PASSING_XML, exitCode: 0 }) })

    expect((await run("check")).exitCode).toBe(0)
  })

  it("exits 2 and names the field when interlint.yaml is invalid", async () => {
    writeFileSync(join(projectDir, "interlint.yaml"), "checks:\n  - name: architecture\n")

    expect(await run("check")).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: "interlint: interlint.yaml: checks[0].run must be a non-empty string\n",
    })
  })

  it("exits 2 when interlint.yaml is missing", async () => {
    expect(await run("check")).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: `interlint: interlint.yaml not found in ${projectDir}\n`,
    })
  })

  it("exits 2, not 1, on an unexpected error, so adapters never mistake it for a violation", async () => {
    mkdirSync(join(projectDir, "interlint.yaml"))

    const { exitCode, stderr } = await run("check")

    expect(exitCode).toBe(2)
    expect(stderr).toMatch(/^interlint: unexpected error: /)
  })

  it("exits 2 for an unknown --when value", async () => {
    writeConfig({ name: "architecture", run: fakeCheck("arch", { report: PASSING_XML, exitCode: 0 }) })

    const { exitCode, stderr } = await run("check", "--when", "commit")

    expect(exitCode).toBe(2)
    expect(stderr).toBe('interlint: --when must be edit or task-end (got "commit")\n')
  })

  it("exits 2 when --file is given at task end", async () => {
    writeConfig({ name: "architecture", run: fakeCheck("arch", { report: PASSING_XML, exitCode: 0 }) })

    expect(await run("check", "--when", "task-end", "--file", "src/main/java/shop/Order.java")).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: "interlint: --file is only valid with --when edit\n",
    })
  })
})

describe("interlint check with report: maven", () => {
  /** A stand-in for Maven running pmd:check: writes target/pmd.xml (or not), prints some output and exits. */
  function fakePmd(options: { violation?: boolean; exitCode: number; output?: string }) {
    const report = options.violation
      ? `<pmd><file name="${join(projectDir, "src", "main", "java", "shop", "Order.java")}"><violation beginline="11" rule="EmptyCatchBlock" priority="3">Avoid empty catch blocks</violation></file></pmd>`
      : undefined
    writeFileSync(
      join(projectDir, "pmd.mjs"),
      `import { mkdirSync, writeFileSync } from "node:fs"
const report = ${JSON.stringify(report ?? "")}
if (report) {
  mkdirSync("target", { recursive: true })
  writeFileSync("target/pmd.xml", report)
}
console.log(${JSON.stringify(options.output ?? "")})
process.exit(${options.exitCode})
`,
    )
    writeConfig({ name: "pmd", run: "node pmd.mjs", report: "maven" })
  }

  it("shows the rule and file:line when Maven says PMD's check failed", async () => {
    fakePmd({
      violation: true,
      exitCode: 1,
      output: "[ERROR] Failed to execute goal org.apache.maven.plugins:maven-pmd-plugin:3.26.0:check (default-cli) on project shop",
    })

    const { exitCode, stdout } = await run("check")

    expect(exitCode).toBe(1)
    expect(stdout).toContain("✗ pmd · EmptyCatchBlock\n\n  Avoid empty catch blocks\n    at src/main/java/shop/Order.java:11\n")
  })

  it("passes when Maven exits 0, even if the report lists what the build accepts", async () => {
    fakePmd({ violation: true, exitCode: 0 })

    expect(await run("check")).toEqual({ exitCode: 0, stdout: "", stderr: "" })
  })

  it("passes when Maven exits 0 without writing a report, as when the build skips the plugin", async () => {
    fakePmd({ exitCode: 0, output: "[INFO] Skipping PMD execution" })

    expect(await run("check")).toEqual({ exitCode: 0, stdout: "", stderr: "" })
  })
})

describe("interlint check --when task-end --changed", () => {
  function writeProject(name: string, exitCode: number) {
    mkdirSync(join(projectDir, name), { recursive: true })
    writeFileSync(
      join(projectDir, name, "check.mjs"),
      `import { writeFileSync } from "node:fs"\nwriteFileSync("../${name}.ran", "")\nprocess.exit(${exitCode})\n`,
    )
    return { name: `${name}/checkstyle`, dir: name, run: "node check.mjs", report: "maven" }
  }

  function writeProjects(...checks: { name: string; dir: string; run: string; report: string }[]) {
    const entries = checks.map(
      (check) =>
        `  - name: ${check.name}\n    dir: ${check.dir}\n    run: ${check.run}\n    report: ${check.report}\n    when: task-end\n`,
    )
    writeFileSync(join(projectDir, "interlint.yaml"), `checks:\n${entries.join("")}`)
  }

  const ran = (name: string) => existsSync(join(projectDir, `${name}.ran`))

  it("runs nothing for projects it has not seen change, so the first task end does not run every project", async () => {
    writeProjects(writeProject("orders", 0), writeProject("billing", 0))

    expect(await run("check", "--when", "task-end", "--changed")).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    expect([ran("orders"), ran("billing")]).toEqual([false, false])
  })

  it("runs only the projects an edit touched, and not again once their checks passed", async () => {
    writeProjects(writeProject("orders", 0), writeProject("billing", 0))
    await run("check", "--when", "task-end", "--changed")

    await run("check", "--when", "edit", "--file", "billing/src/main/resources/application.yml")
    expect((await run("check", "--when", "task-end", "--changed")).exitCode).toBe(0)
    expect([ran("orders"), ran("billing")]).toEqual([false, true])

    rmSync(join(projectDir, "billing.ran"))
    await run("check", "--when", "task-end", "--changed")
    expect(ran("billing")).toBe(false)
  })

  it("runs a project whose files changed since its checks last passed, however they changed", async () => {
    writeProjects(writeProject("orders", 0), writeProject("billing", 0))
    await run("check", "--when", "task-end", "--changed")

    writeFileSync(join(projectDir, "orders", "Order.java"), "class Order {}")
    await run("check", "--when", "task-end", "--changed")

    expect([ran("orders"), ran("billing")]).toEqual([true, false])
  })

  it("keeps running a failing project until its checks pass", async () => {
    writeProjects(writeProject("orders", 1))
    await run("check", "--when", "edit", "--file", "orders/pom.xml")

    expect((await run("check", "--when", "task-end", "--changed")).exitCode).toBe(1)
    expect((await run("check", "--when", "task-end", "--changed")).exitCode).toBe(1)
  })

  it("is only valid with --when task-end", async () => {
    expect(await run("check", "--when", "edit", "--file", "a.java", "--changed")).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: "interlint: --changed is only valid with --when task-end\n",
    })
  })
})

describe("interlint check --when edit", () => {
  const ORDER = join("src", "main", "java", "shop", "Order.java")

  it("runs only the edit checks when a Java source changed", async () => {
    writeConfig(
      { name: "fast", run: fakeCheck("fast", { report: VIOLATIONS_XML, exitCode: 1 }), when: "edit" },
      { name: "slow", run: fakeCheck("slow", { report: VIOLATIONS_XML, exitCode: 1 }) },
    )

    const { exitCode, stdout } = await run("check", "--when", "edit", "--file", ORDER)

    expect(exitCode).toBe(1)
    expect(stdout).toContain("✗ fast · ARCH-01: application has ZERO dependencies on infrastructure\n")
    expect(stdout).not.toContain("✗ slow")
  })

  it("prints what task-end prints for the same failures", async () => {
    writeConfig({ name: "architecture", run: fakeCheck("arch", { report: VIOLATIONS_XML, exitCode: 1 }), when: "edit" })
    const atTaskEnd = await run("check", "--when", "task-end")

    expect(await run("check", "--when", "edit", "--file", ORDER)).toEqual(atTaskEnd)
  })

  it("runs nothing and exits 0 when the changed file is not a source", async () => {
    writeConfig({ name: "fast", run: fakeCheck("fast", { report: VIOLATIONS_XML, exitCode: 1 }), when: "edit" })

    expect(await run("check", "--when", "edit", "--file", "README.md")).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    expect(existsSync(join(projectDir, "target"))).toBe(false)
  })

  it("ignores a changed file outside the project", async () => {
    writeConfig({ name: "fast", run: fakeCheck("fast", { report: VIOLATIONS_XML, exitCode: 1 }), when: "edit" })
    const outside = join(projectDir, "..", "other", "Order.java")

    expect(await run("check", "--when", "edit", "--file", outside)).toEqual({ exitCode: 0, stdout: "", stderr: "" })
  })

  it("accepts an absolute path and several --file options", async () => {
    writeConfig({ name: "fast", run: fakeCheck("fast", { report: VIOLATIONS_XML, exitCode: 1 }), when: "edit" })

    const { exitCode } = await run("check", "--when", "edit", "--file", "README.md", "--file", join(projectDir, ORDER))

    expect(exitCode).toBe(1)
  })

  it("never runs two builds at the same time on the same project", async () => {
    const log = join(projectDir, "builds.log")
    writeFileSync(
      join(projectDir, "slow.mjs"),
      `import { appendFileSync } from "node:fs"
appendFileSync(${JSON.stringify(log)}, "start\\n")
await new Promise((resolve) => setTimeout(resolve, 300))
appendFileSync(${JSON.stringify(log)}, "end\\n")
process.exit(1)
`,
    )
    writeConfig({ name: "slow", run: "node slow.mjs", when: "edit" })

    await Promise.all([run("check", "--when", "edit", "--file", ORDER), run("check", "--when", "edit", "--file", ORDER)])

    expect(readFileSync(log, "utf8")).toBe("start\nend\nstart\nend\n")
  })

  it("does not wait for a running build when no check applies", async () => {
    writeConfig({ name: "fast", run: fakeCheck("fast", { report: VIOLATIONS_XML, exitCode: 1 }), when: "edit" })
    mkdirSync(dirname(lockFileFor(projectDir)), { recursive: true })
    writeFileSync(lockFileFor(projectDir), String(process.pid))

    try {
      expect(await run("check", "--when", "edit", "--file", "README.md")).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    } finally {
      rmSync(lockFileFor(projectDir), { force: true })
    }
  })

  it("exits 2 without --file", async () => {
    writeConfig({ name: "fast", run: fakeCheck("fast", { report: PASSING_XML, exitCode: 0 }), when: "edit" })

    expect(await run("check", "--when", "edit")).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: "interlint: --when edit needs at least one --file <path>\n",
    })
  })
})

describe("interlint usage", () => {
  it("prints the usage with --help", async () => {
    const { exitCode, stdout } = await run("--help")

    expect(exitCode).toBe(0)
    expect(stdout).toContain("interlint check [--when task-end] [--changed] [--cwd <dir>]")
    expect(stdout).toContain("interlint check --when edit --file <path>... [--cwd <dir>]")
  })

  it("exits 2 for an unknown command", async () => {
    const { exitCode, stderr } = await run("lint")

    expect(exitCode).toBe(2)
    expect(stderr).toContain('interlint: unknown command "lint"')
  })
})
