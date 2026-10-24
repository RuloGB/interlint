import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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
  projectDir = mkdtempSync(join(tmpdir(), "interlint-claude-"))
  stateDir = mkdtempSync(join(tmpdir(), "interlint-claude-state-"))
  // The stop hook keeps its block count under the OS temp directory.
  for (const name of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(name, stateDir)
  vi.stubEnv("CLAUDE_PROJECT_DIR", projectDir)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(projectDir, { recursive: true, force: true })
  rmSync(stateDir, { recursive: true, force: true })
})

/** A check whose report the test can switch between passing and failing. */
function writeCheck(when: "edit" | "task-end", report: string) {
  writeFileSync(join(projectDir, "report.xml"), report)
  writeFileSync(
    join(projectDir, "check.mjs"),
    `import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
const report = readFileSync("report.xml", "utf8")
mkdirSync("target/surefire-reports", { recursive: true })
writeFileSync("target/surefire-reports/TEST-ArchitectureRulesTest.xml", report)
writeFileSync("ran", "")
process.exit(report.includes("<failure") ? 1 : 0)
`,
  )
  writeFileSync(
    join(projectDir, "interlint.yaml"),
    `checks:\n  - name: architecture\n    run: node check.mjs\n    report: archunit\n    when: ${when}\n`,
  )
}

function postToolUse(filePath: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    session_id: "session-1",
    cwd: projectDir,
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: filePath, old_string: "a", new_string: "b" },
    tool_response: { filePath, success: true },
    ...extra,
  })
}

function stopInput(stopHookActive: boolean, sessionId = "session-1") {
  return JSON.stringify({
    session_id: sessionId,
    cwd: projectDir,
    hook_event_name: "Stop",
    stop_hook_active: stopHookActive,
    last_assistant_message: "Done.",
  })
}

async function hook(event: string, stdin: string, cwd = projectDir) {
  let stdout = ""
  let stderr = ""
  const exitCode = await main(["hook", "claude-code", event], {
    cwd,
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    stdin: async () => stdin,
  })
  return { exitCode, stdout, stderr }
}

const JAVA_FILE = () => join(projectDir, "src", "main", "java", "shop", "Order.java")

describe("interlint hook claude-code post-edit", () => {
  it("runs the edit checks for the edited file and blocks with the failures on stderr", async () => {
    writeCheck("edit", VIOLATIONS_XML)

    const { exitCode, stdout, stderr } = await hook("post-edit", postToolUse(JAVA_FILE()))

    expect(exitCode).toBe(2)
    expect(stdout).toBe("")
    expect(stderr).toMatch(/^Interlint: the checks fail after this edit\.\n\n✗ architecture · ARCH-01/)
    expect(stderr).toContain("Fix these problems before continuing.")
  })

  it("prints nothing and exits 0 when the checks pass", async () => {
    writeCheck("edit", PASSING_XML)

    expect(await hook("post-edit", postToolUse(JAVA_FILE()))).toEqual({ exitCode: 0, stdout: "", stderr: "" })
  })

  it("runs nothing for a file that no check reads", async () => {
    writeCheck("edit", VIOLATIONS_XML)

    const result = await hook("post-edit", postToolUse(join(projectDir, "README.md")))

    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    expect(() => readFileSync(join(projectDir, "ran"))).toThrow()
  })

  it("runs only edit checks", async () => {
    writeCheck("task-end", VIOLATIONS_XML)

    expect((await hook("post-edit", postToolUse(JAVA_FILE()))).exitCode).toBe(0)
  })

  it("does nothing for an input without a file path", async () => {
    writeCheck("edit", VIOLATIONS_XML)

    const input = JSON.stringify({ session_id: "s", cwd: projectDir, hook_event_name: "PostToolUse", tool_input: {} })
    expect(await hook("post-edit", input)).toEqual({ exitCode: 0, stdout: "", stderr: "" })
  })

  it("uses the input's cwd when CLAUDE_PROJECT_DIR is not set", async () => {
    vi.stubEnv("CLAUDE_PROJECT_DIR", "")
    writeCheck("edit", VIOLATIONS_XML)

    expect((await hook("post-edit", postToolUse(JAVA_FILE()), stateDir)).exitCode).toBe(2)
  })

  it("exits 1, which Claude Code does not treat as a block, when there is no interlint.yaml", async () => {
    const { exitCode, stderr } = await hook("post-edit", postToolUse(JAVA_FILE()))

    expect(exitCode).toBe(1)
    expect(stderr).toContain("interlint.yaml")
  })

  it("exits 1 when stdin is not a hook's JSON", async () => {
    const { exitCode, stderr } = await hook("post-edit", "not json")

    expect(exitCode).toBe(1)
    expect(stderr).toMatch(/^interlint: /)
  })
})

describe("interlint hook claude-code stop", () => {
  it("blocks with the failures on stderr when a check fails", async () => {
    writeCheck("edit", VIOLATIONS_XML)

    const { exitCode, stdout, stderr } = await hook("stop", stopInput(false))

    expect(exitCode).toBe(2)
    expect(stdout).toBe("")
    expect(stderr).toMatch(/^Interlint: the task cannot end yet \(attempt 1 of 3\)\.\n\n✗ architecture · ARCH-01/)
  })

  it("runs every check, edit ones included, and exits 0 silently when they pass", async () => {
    writeCheck("edit", PASSING_XML)

    expect(await hook("stop", stopInput(false))).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    expect(readFileSync(join(projectDir, "ran"), "utf8")).toBe("")
  })

  it("lets the task end after 3 blocks in a row and shows the failures to the user", async () => {
    writeCheck("task-end", VIOLATIONS_XML)

    const attempts = [await hook("stop", stopInput(false))]
    for (let index = 0; index < 3; index++) attempts.push(await hook("stop", stopInput(true)))

    expect(attempts.map((attempt) => attempt.exitCode)).toEqual([2, 2, 2, 0])
    expect(attempts[2]!.stderr).toMatch(/^Interlint: the task cannot end yet \(attempt 3 of 3\)/)
    const last = attempts[3]!
    expect(last.stderr).toBe("")
    const output = JSON.parse(last.stdout) as { systemMessage: string }
    expect(output.systemMessage).toMatch(
      /^Interlint: the checks still fail after 3 attempts, so the task may end\.\n\n✗ architecture · ARCH-01/,
    )
  })

  it("starts counting again when Claude Code is not continuing because of a stop hook", async () => {
    writeCheck("task-end", VIOLATIONS_XML)
    await hook("stop", stopInput(false))
    await hook("stop", stopInput(true))

    expect((await hook("stop", stopInput(false))).stderr).toMatch(/\(attempt 1 of 3\)/)
  })

  it("starts counting again after the checks pass", async () => {
    writeCheck("task-end", VIOLATIONS_XML)
    await hook("stop", stopInput(false))
    await hook("stop", stopInput(true))
    writeCheck("task-end", PASSING_XML)
    expect((await hook("stop", stopInput(true))).exitCode).toBe(0)
    writeCheck("task-end", VIOLATIONS_XML)

    expect((await hook("stop", stopInput(true))).stderr).toMatch(/\(attempt 1 of 3\)/)
  })

  it("counts each session on its own", async () => {
    writeCheck("task-end", VIOLATIONS_XML)
    await hook("stop", stopInput(false, "session-a"))
    await hook("stop", stopInput(true, "session-a"))

    expect((await hook("stop", stopInput(true, "session-b"))).stderr).toMatch(/\(attempt 1 of 3\)/)
  })

  it("exits 1, so the task can end, when the checks cannot run", async () => {
    const { exitCode, stderr } = await hook("stop", stopInput(false))

    expect(exitCode).toBe(1)
    expect(stderr).toContain("interlint.yaml")
  })
})

describe("interlint hook", () => {
  it("exits 1 for an unknown event, so a typo never blocks the agent", async () => {
    const { exitCode, stderr } = await hook("post-commit", "{}")

    expect(exitCode).toBe(1)
    expect(stderr).toContain("post-edit")
  })

  it("exits 1 for an unknown agent", async () => {
    let stderr = ""
    const exitCode = await main(["hook", "cursor", "stop"], {
      cwd: projectDir,
      stdout: () => {},
      stderr: (text) => (stderr += text),
      stdin: async () => "{}",
    })

    expect(exitCode).toBe(1)
    expect(stderr).toContain("claude-code")
  })
})
