import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { userStateDir } from "../src/adapters/state/user-state.js"
import { main } from "../src/cli.js"

const VIOLATIONS_XML = readFileSync(
  join(import.meta.dirname, "fixtures", "surefire", "two-rules-violated.xml"),
  "utf8",
)
const PASSING_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="ArchitectureRulesTest" tests="1"><testcase name="DOMAIN_IS_PURE" classname="ArchitectureRulesTest"/></testsuite>`

let projectDir: string
let stateDir: string
let tempDir: string

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "interlint-claude-"))
  stateDir = mkdtempSync(join(tmpdir(), "interlint-claude-state-"))
  tempDir = mkdtempSync(join(tmpdir(), "interlint-claude-temp-"))
  // The stop hook keeps its block count in the user's state directory: LOCALAPPDATA on Windows, XDG_STATE_HOME elsewhere.
  vi.stubEnv("LOCALAPPDATA", stateDir)
  vi.stubEnv("XDG_STATE_HOME", stateDir)
  for (const name of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(name, tempDir)
  vi.stubEnv("CLAUDE_PROJECT_DIR", projectDir)
})

afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of [projectDir, stateDir, tempDir]) rmSync(dir, { recursive: true, force: true })
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
writeFileSync("target/ran", "")
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
    expect(() => readFileSync(join(projectDir, "target", "ran"))).toThrow()
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
  /** The agent changes a file of the project: Claude Code runs the post-edit hook for it. */
  async function agentEdits() {
    await hook("post-edit", postToolUse(join(projectDir, "README.md")))
  }

  it("runs nothing when the agent changed nothing since the checks last passed", async () => {
    writeCheck("task-end", VIOLATIONS_XML)

    expect(await hook("stop", stopInput(false))).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    expect(existsSync(join(projectDir, "target", "ran"))).toBe(false)
  })

  it("blocks with a check whose dir does not exist, so a typo in dir is never silent", async () => {
    writeFileSync(
      join(projectDir, "interlint.yaml"),
      "checks:\n  - name: odrers/architecture\n    dir: odrers\n    run: node check.mjs\n    report: archunit\n    when: edit\n",
    )

    const { exitCode, stderr } = await hook("stop", stopInput(false))

    expect(exitCode).toBe(2)
    expect(stderr).toMatch(/\(attempt 1 of 3\)\.\n\n✗ odrers\/architecture · its dir "odrers" does not exist/)
  })

  it("runs the checks again once a file changed after they passed, whoever changed it", async () => {
    writeCheck("task-end", PASSING_XML)
    await agentEdits()
    expect((await hook("stop", stopInput(false))).exitCode).toBe(0)
    // The check rewrites its report on every run, and build output never counts as a change.
    const report = join(projectDir, "target", "surefire-reports", "TEST-ArchitectureRulesTest.xml")
    const ranAt = statSync(report).mtimeMs
    expect((await hook("stop", stopInput(false))).exitCode).toBe(0)
    expect(statSync(report).mtimeMs).toBe(ranAt)

    writeFileSync(join(projectDir, "report.xml"), VIOLATIONS_XML)

    expect((await hook("stop", stopInput(false))).exitCode).toBe(2)
  })

  it("blocks with the failures on stderr when a check fails", async () => {
    writeCheck("edit", VIOLATIONS_XML)
    await agentEdits()

    const { exitCode, stdout, stderr } = await hook("stop", stopInput(false))

    expect(exitCode).toBe(2)
    expect(stdout).toBe("")
    expect(stderr).toMatch(/^Interlint: the task cannot end yet \(attempt 1 of 3\)\.\n\n✗ architecture · ARCH-01/)
  })

  it("runs every check, edit ones included, and exits 0 silently when they pass", async () => {
    writeCheck("edit", PASSING_XML)
    await agentEdits()

    expect(await hook("stop", stopInput(false))).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    expect(readFileSync(join(projectDir, "target", "ran"), "utf8")).toBe("")
  })

  it("lets the task end after 3 blocks in a row and shows the failures to the user", async () => {
    writeCheck("task-end", VIOLATIONS_XML)
    await agentEdits()

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

  it("does not block again after letting the task end while Claude Code keeps continuing", async () => {
    writeCheck("task-end", VIOLATIONS_XML)
    await agentEdits()
    await hook("stop", stopInput(false))
    for (let index = 0; index < 3; index++) await hook("stop", stopInput(true))

    // Another stop hook may keep Claude going: Interlint already let the task end and stays quiet.
    expect(await hook("stop", stopInput(true))).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    expect((await hook("stop", stopInput(false))).stderr).toMatch(/\(attempt 1 of 3\)/)
  })

  it("keeps the block count in the user's own state directory, not in the shared temp directory", async () => {
    writeCheck("task-end", VIOLATIONS_XML)
    await agentEdits()

    await hook("stop", stopInput(false))

    expect(readdirSync(join(stateDir, "interlint", "claude-code-stop"))).toHaveLength(1)
    expect(readdirSync(tempDir)).not.toContain("interlint")
  })

  it("starts counting again when Claude Code is not continuing because of a stop hook", async () => {
    writeCheck("task-end", VIOLATIONS_XML)
    await agentEdits()
    await hook("stop", stopInput(false))
    await hook("stop", stopInput(true))

    expect((await hook("stop", stopInput(false))).stderr).toMatch(/\(attempt 1 of 3\)/)
  })

  it("starts counting again after the checks pass", async () => {
    writeCheck("task-end", VIOLATIONS_XML)
    await agentEdits()
    await hook("stop", stopInput(false))
    await hook("stop", stopInput(true))
    writeCheck("task-end", PASSING_XML)
    expect((await hook("stop", stopInput(true))).exitCode).toBe(0)
    writeCheck("task-end", VIOLATIONS_XML)
    await agentEdits()

    expect((await hook("stop", stopInput(true))).stderr).toMatch(/\(attempt 1 of 3\)/)
  })

  it("counts each session on its own", async () => {
    writeCheck("task-end", VIOLATIONS_XML)
    await agentEdits()
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

describe("interlint hook claude-code subagent-stop", () => {
  function subagentStopInput(stopHookActive: boolean, agentId = "writer-1") {
    return JSON.stringify({
      session_id: "session-1",
      cwd: projectDir,
      hook_event_name: "SubagentStop",
      stop_hook_active: stopHookActive,
      agent_id: agentId,
      agent_type: "writer",
      last_assistant_message: "Done.",
    })
  }

  /** A subagent edits a file: Claude Code runs the post-edit hook with the subagent's agent_id. */
  async function subagentEdits(file: string, agentId = "writer-1") {
    await hook("post-edit", postToolUse(file, { agent_id: agentId, agent_type: "writer" }))
  }

  /** Two projects of a workspace, each with a check whose failure the test picks. */
  function writeWorkspace(failing: { orders: boolean; billing: boolean }) {
    const entries = (["orders", "billing"] as const).map((name) => {
      mkdirSync(join(projectDir, name), { recursive: true })
      writeFileSync(join(projectDir, name, "check.mjs"), `process.exit(${failing[name] ? 1 : 0})\n`)
      return `  - name: ${name}/checkstyle\n    dir: ${name}\n    run: node check.mjs\n    report: maven\n    when: task-end\n`
    })
    writeFileSync(join(projectDir, "interlint.yaml"), `checks:\n${entries.join("")}`)
  }

  it("runs nothing when a subagent that changed no file stops, such as a read-only reviewer", async () => {
    writeCheck("task-end", VIOLATIONS_XML)
    await hook("post-edit", postToolUse(join(projectDir, "README.md")))

    expect(await hook("subagent-stop", subagentStopInput(false, "reviewer-1"))).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    expect(existsSync(join(projectDir, "target", "ran"))).toBe(false)
  })

  it("keeps a subagent that changed files working with the failures of its checks", async () => {
    writeCheck("task-end", VIOLATIONS_XML)
    await subagentEdits(JAVA_FILE())

    const { exitCode, stdout, stderr } = await hook("subagent-stop", subagentStopInput(false))

    expect(exitCode).toBe(2)
    expect(stdout).toBe("")
    expect(stderr).toMatch(/^Interlint: the task cannot end yet \(attempt 1 of 3\)\.\n\n✗ architecture · ARCH-01/)
  })

  it("gives a subagent only the failures of the projects it changed", async () => {
    writeWorkspace({ orders: false, billing: true })
    await hook("post-edit", postToolUse(join(projectDir, "billing", "pom.xml")))
    await subagentEdits(join(projectDir, "orders", "pom.xml"))

    expect(await hook("subagent-stop", subagentStopInput(false))).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    const { exitCode, stderr } = await hook("stop", stopInput(false))
    expect(exitCode).toBe(2)
    expect(stderr).toContain("billing/checkstyle")
    expect(stderr).not.toContain("orders/checkstyle")
  })

  it("lets the subagent stop after 3 blocks, and the main agent's stop gets the failures", async () => {
    writeCheck("task-end", VIOLATIONS_XML)
    await subagentEdits(JAVA_FILE())

    const attempts = [await hook("subagent-stop", subagentStopInput(false))]
    for (let index = 0; index < 3; index++) attempts.push(await hook("subagent-stop", subagentStopInput(true)))

    expect(attempts.map((attempt) => attempt.exitCode)).toEqual([2, 2, 2, 0])
    expect(attempts[3]).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    const { exitCode, stderr } = await hook("stop", stopInput(false))
    expect(exitCode).toBe(2)
    expect(stderr).toMatch(/\(attempt 1 of 3\)\.\n\n✗ architecture · ARCH-01/)
  })

  it("runs nothing at the next stop of a subagent whose checks passed, until it changes a file again", async () => {
    writeCheck("task-end", PASSING_XML)
    await subagentEdits(JAVA_FILE())
    expect((await hook("subagent-stop", subagentStopInput(false))).exitCode).toBe(0)
    writeFileSync(join(projectDir, "report.xml"), VIOLATIONS_XML)

    expect((await hook("subagent-stop", subagentStopInput(false))).exitCode).toBe(0)
    await subagentEdits(JAVA_FILE())
    expect((await hook("subagent-stop", subagentStopInput(false))).exitCode).toBe(2)
  })

  it("forgets, after a week, the files of a subagent that never stopped", async () => {
    writeCheck("task-end", PASSING_XML)
    const records = join(userStateDir(), "interlint", "claude-code-subagents")
    mkdirSync(records, { recursive: true })
    const stale = join(records, "interrupted-subagent")
    writeFileSync(stale, "orders/pom.xml\n")
    const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000
    utimesSync(stale, eightDaysAgo, eightDaysAgo)

    await subagentEdits(JAVA_FILE())

    expect(existsSync(stale)).toBe(false)
    expect(readdirSync(records)).toHaveLength(1)
  })

  it("counts the blocks of each subagent on its own", async () => {
    writeCheck("task-end", VIOLATIONS_XML)
    await subagentEdits(JAVA_FILE(), "writer-1")
    await subagentEdits(JAVA_FILE(), "writer-2")
    await hook("subagent-stop", subagentStopInput(false, "writer-1"))
    await hook("subagent-stop", subagentStopInput(true, "writer-1"))

    expect((await hook("subagent-stop", subagentStopInput(false, "writer-2"))).stderr).toMatch(/\(attempt 1 of 3\)/)
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

describe("userStateDir", () => {
  it("uses XDG_STATE_HOME when it is an absolute path", () => {
    expect(userStateDir("linux", { XDG_STATE_HOME: "/var/state" })).toBe("/var/state")
  })

  it("ignores a relative XDG_STATE_HOME, as the XDG spec asks, so the count never lands in the project", () => {
    expect(userStateDir("linux", { XDG_STATE_HOME: "state" })).toBe(join(homedir(), ".local", "state"))
  })

  it("falls back to ~/.local/state without XDG_STATE_HOME", () => {
    expect(userStateDir("linux", {})).toBe(join(homedir(), ".local", "state"))
  })

  it("uses LOCALAPPDATA on Windows, and ignores it when it is relative", () => {
    expect(userStateDir("win32", { LOCALAPPDATA: "C:/Users/me/AppData/Local" })).toBe("C:/Users/me/AppData/Local")
    expect(userStateDir("win32", { LOCALAPPDATA: "AppData" })).toBe(join(homedir(), "AppData", "Local"))
  })
})
