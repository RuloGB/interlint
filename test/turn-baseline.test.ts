import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { withChangesBetweenTurns } from "../src/domain/turn-baseline.js"
import { main } from "../src/main.js"

const VIOLATIONS_XML = readFileSync(join(import.meta.dirname, "fixtures", "surefire", "two-rules-violated.xml"), "utf8")
const PASSING_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="ArchitectureRulesTest" tests="1"><testcase name="DOMAIN_IS_PURE" classname="ArchitectureRulesTest"/></testsuite>`

const ARCH_TEST = "src/test/java/shop/arch/ArchitectureTest.java"
const ORDER = "src/main/java/shop/Order.java"
const PROTECT_ARCH = `protected:\n  - "src/test/java/**/arch/**"\n`

let projectDir: string
let stateDir: string

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "interlint-turn-"))
  stateDir = mkdtempSync(join(tmpdir(), "interlint-turn-state-"))
  vi.stubEnv("LOCALAPPDATA", stateDir)
  vi.stubEnv("XDG_STATE_HOME", stateDir)
  vi.stubEnv("CLAUDE_PROJECT_DIR", projectDir)
})

afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of [projectDir, stateDir]) rmSync(dir, { recursive: true, force: true })
})

function writeFile(path: string, content: string) {
  mkdirSync(dirname(join(projectDir, path)), { recursive: true })
  writeFileSync(join(projectDir, path), content)
}

/** A project with one task-end check, which writes `target/ran` whenever it runs and fails while `report.xml` holds violations. */
function project(report: string, top = "") {
  writeFile("report.xml", report)
  writeFile(
    "check.mjs",
    `import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
const report = readFileSync("report.xml", "utf8")
mkdirSync("target/surefire-reports", { recursive: true })
writeFileSync("target/surefire-reports/TEST-ArchitectureRulesTest.xml", report)
writeFileSync("target/ran", "")
process.exit(report.includes("<failure") ? 1 : 0)
`,
  )
  writeFile("interlint.yaml", `checks:\n  - name: architecture\n    run: node check.mjs\n    report: archunit\n    when: task-end\n${top}`)
  writeFile(ARCH_TEST, "class ArchitectureTest {}\n")
}

const ran = () => existsSync(join(projectDir, "target", "ran"))
const forgetRun = () => rmSync(join(projectDir, "target", "ran"), { force: true })

/** What a `git pull` does to the project: a change the agent's checks would reject, made by nobody's edit tool. */
function pull() {
  writeFile("report.xml", VIOLATIONS_XML)
  writeFile(ORDER, "class Order { int pulled; }\n")
  forgetRun()
}

async function cli(args: string[], stdin: string) {
  let stdout = ""
  let stderr = ""
  const exitCode = await main(args, {
    cwd: projectDir,
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    stdin: async () => stdin,
  })
  return { exitCode, stdout, stderr }
}

const claude = (event: string, input: Record<string, unknown> = {}) =>
  cli(["hook", "claude-code", event], JSON.stringify({ session_id: "session-1", cwd: projectDir, ...input }))

const prompt = (text = "go on with the order", input: Record<string, unknown> = {}) =>
  claude("user-prompt", { hook_event_name: "UserPromptSubmit", prompt: text, ...input })

async function edit(path: string, content = "class Order {}\n", input: Record<string, unknown> = {}) {
  writeFile(path, content)
  return claude("post-edit", {
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: join(projectDir, path), content },
    ...input,
  })
}

const stop = (input: Record<string, unknown> = {}) => claude("stop", { hook_event_name: "Stop", stop_hook_active: false, ...input })

describe("the changes made between two turns of a session", () => {
  it("run no task-end check: the user made them, as with a git pull", async () => {
    project(PASSING_XML)
    await edit(ORDER)
    expect((await stop()).exitCode).toBe(0)
    pull()

    await prompt()
    const stopped = await stop()

    expect(stopped).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    expect(ran()).toBe(false)
  })

  it("are checked once the agent changes the project after the prompt", async () => {
    project(PASSING_XML)
    await edit(ORDER)
    expect((await stop()).exitCode).toBe(0)
    pull()
    await prompt()

    await edit("src/main/java/shop/Customer.java")

    expect((await stop()).exitCode).toBe(2)
  })

  it("are still checked when no prompt came since, as a change the agent made with a shell command", async () => {
    project(PASSING_XML)
    await edit(ORDER)
    expect((await stop()).exitCode).toBe(0)
    pull()

    expect((await stop()).exitCode).toBe(2)
  })

  it("never hide a project the agent left failing at its turn's end", async () => {
    project(VIOLATIONS_XML)
    await edit(ORDER)
    expect((await stop()).exitCode).toBe(2)
    writeFile(ORDER, "class Order { int changedByTheUser; }\n")

    await prompt()
    const { exitCode, stderr } = await stop()

    expect(exitCode).toBe(2)
    expect(stderr).toContain("architecture")
  })

  it("are checked after an edit made since the turn ended, as in a turn the user interrupted", async () => {
    project(PASSING_XML)
    await edit(ORDER)
    expect((await stop()).exitCode).toBe(0)
    writeFile("report.xml", VIOLATIONS_XML)
    await edit(ORDER, "class Order { int interrupted; }\n")

    await prompt()

    expect((await stop()).exitCode).toBe(2)
  })

  it("leave another session alone: its task end still checks the project", async () => {
    project(PASSING_XML)
    await edit(ORDER)
    expect((await stop()).exitCode).toBe(0)
    pull()

    await prompt()
    const other = await stop({ session_id: "session-2" })

    expect(other.exitCode).toBe(2)
  })
})

describe("the protected files changed between two turns", () => {
  it("do not block the task end, as interlint.yaml changed by a git pull", async () => {
    project(PASSING_XML)
    await claude("session-start", { hook_event_name: "SessionStart" })
    await edit(ORDER)
    expect((await stop()).exitCode).toBe(0)
    writeFile("interlint.yaml", `${readFileSync(join(projectDir, "interlint.yaml"), "utf8")}# pulled\n`)

    await prompt()
    const stopped = await stop()

    expect(stopped.exitCode).toBe(0)
    expect(stopped.stdout).not.toContain("protected")
  })

  it("still block for a protected file the agent changed in its turn", async () => {
    project(PASSING_XML, PROTECT_ARCH)
    await claude("session-start", { hook_event_name: "SessionStart" })
    writeFile(ARCH_TEST, "class ArchitectureTest { /* changed by the agent's shell command */ }\n")
    expect((await stop()).exitCode).toBe(2)

    await prompt()
    const { exitCode, stderr } = await stop()

    expect(exitCode).toBe(2)
    expect(stderr).toContain("protected")
  })

  it("still block for a protected file changed after the prompt", async () => {
    project(PASSING_XML, PROTECT_ARCH)
    await claude("session-start", { hook_event_name: "SessionStart" })
    expect((await stop()).exitCode).toBe(0)
    await prompt()

    writeFile(ARCH_TEST, "class ArchitectureTest { /* changed in the agent's turn */ }\n")
    const { exitCode, stderr } = await stop()

    expect(exitCode).toBe(2)
    expect(stderr).toContain("protected")
  })
})

describe("the turn step the OpenCode plugin runs", () => {
  const context = JSON.stringify({ agent: "opencode", session: "oc-1" })

  it("takes the changes made since the session's last task end as the user's", async () => {
    project(PASSING_XML)
    writeFile(ORDER, "class Order {}\n")
    expect((await cli(["check", "--when", "task-end", "--changed", "--agent-context"], context)).exitCode).toBe(0)
    pull()

    expect(await cli(["check", "--when", "turn-start", "--agent-context"], context)).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    const taskEnd = await cli(["check", "--when", "task-end", "--changed", "--agent-context"], context)

    expect(taskEnd.exitCode).toBe(0)
    expect(ran()).toBe(false)
  })

  it("takes nothing in a session the CLI keeps paused, even when the plugin forgot the pause", async () => {
    project(PASSING_XML)
    writeFile(ORDER, "class Order {}\n")
    expect((await cli(["check", "--when", "task-end", "--changed", "--agent-context"], context)).exitCode).toBe(0)
    await cli(["check", "--when", "pause", "--agent-context"], context)
    pull()

    expect(await cli(["check", "--when", "turn-start", "--agent-context"], context)).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    const taskEnd = await cli(["check", "--when", "task-end", "--changed", "--agent-context"], context)

    expect(taskEnd.exitCode).toBe(1)
  })

  it("needs the session in --agent-context", async () => {
    project(PASSING_XML)

    const { exitCode, stderr } = await cli(["check", "--when", "turn-start"], "")

    expect(exitCode).toBe(2)
    expect(stderr).toContain("--when turn-start needs the session in --agent-context")
  })
})

describe("withChangesBetweenTurns", () => {
  it("takes what changed since the turn ended and keeps what the agent changed in its turn", () => {
    const baseline = { agent: "a0", user: "u0", gone: "g0" }
    const turnEnd = { agent: "a1", user: "u0", gone: "g0" }
    const now = { agent: "a1", user: "u1", created: "c1" }

    expect(withChangesBetweenTurns(baseline, turnEnd, now)).toEqual({ agent: "a0", user: "u1", created: "c1" })
  })
})
