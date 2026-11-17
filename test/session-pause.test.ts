import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { decideStop } from "../src/application/feedback/stop-policy.js"
import { isSessionMetricLine } from "../src/domain/metric.js"
import {
  NOT_PAUSED_MESSAGE,
  PAUSE_ADVICE,
  PAUSED_MESSAGE,
  PAUSED_REMINDER,
  pauseMarkOf,
  RESUMED_MESSAGE,
} from "../src/domain/session-pause.js"
import { main } from "../src/main.js"

const VIOLATIONS_XML = readFileSync(join(import.meta.dirname, "fixtures", "surefire", "two-rules-violated.xml"), "utf8")
const PASSING_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="ArchitectureRulesTest" tests="1"><testcase name="DOMAIN_IS_PURE" classname="ArchitectureRulesTest"/></testsuite>`

const ARCH_TEST = "src/test/java/shop/arch/ArchitectureTest.java"
const ORDER = "src/main/java/shop/Order.java"

let projectDir: string
let stateDir: string

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "interlint-pause-"))
  stateDir = mkdtempSync(join(tmpdir(), "interlint-pause-state-"))
  vi.stubEnv("LOCALAPPDATA", stateDir)
  vi.stubEnv("XDG_STATE_HOME", stateDir)
  vi.stubEnv("CLAUDE_PROJECT_DIR", projectDir)
  vi.stubEnv("COPILOT_PROJECT_DIR", projectDir)
})

afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of [projectDir, stateDir]) rmSync(dir, { recursive: true, force: true })
})

function writeFile(path: string, content: string) {
  mkdirSync(dirname(join(projectDir, path)), { recursive: true })
  writeFileSync(join(projectDir, path), content)
}

/**
 * A project with one check, which writes `target/ran` whenever it runs and fails while `report.xml` holds violations.
 * `extra` goes under the check, such as `every`, and `top` after the checks, such as `protected`.
 */
function project(report: string, { when = "edit", extra = "", top = "" } = {}) {
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
  writeFile("interlint.yaml", `checks:\n  - name: architecture\n    run: node check.mjs\n    report: archunit\n    when: ${when}\n${extra}${top}`)
  writeFile(ARCH_TEST, "class ArchitectureTest {}\n")
}

const ran = () => existsSync(join(projectDir, "target", "ran"))
const forgetRun = () => rmSync(join(projectDir, "target", "ran"), { force: true })

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

const prompt = (text: string, input: Record<string, unknown> = {}) =>
  claude("user-prompt", { hook_event_name: "UserPromptSubmit", prompt: text, ...input })

/** The agent edits a file of the project with its edit tool, writing `content` in it. */
async function edit(path: string, content = "class Order {}\n", input: Record<string, unknown> = {}) {
  writeFile(path, content)
  return claude("post-edit", {
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: join(projectDir, path), content },
    ...input,
  })
}

const stop = (stopHookActive = false, input: Record<string, unknown> = {}) =>
  claude("stop", { hook_event_name: "Stop", stop_hook_active: stopHookActive, ...input })

/** What a hook that exits 0 tells the user, read from its JSON on stdout. */
const systemMessage = (stdout: string): string => JSON.parse(stdout).systemMessage

describe("the pause marks", () => {
  it("finds them anywhere in the prompt, in any case", () => {
    expect(pauseMarkOf("interlint: pause")).toBe("pause")
    expect(pauseMarkOf("Leave it as it is. INTERLINT: Pause, please")).toBe("pause")
    expect(pauseMarkOf("ok\ninterlint:resume\nand go on")).toBe("resume")
  })

  it("takes the last mark when the prompt holds both", () => {
    expect(pauseMarkOf("interlint: pause ... interlint: resume")).toBe("resume")
  })

  it("finds none in other words or without the colon", () => {
    expect(pauseMarkOf("interlint: paused")).toBeUndefined()
    expect(pauseMarkOf("interlint pause")).toBeUndefined()
    expect(pauseMarkOf("pause interlint")).toBeUndefined()
    expect(pauseMarkOf("fix the build")).toBeUndefined()
  })
})

describe("pausing Interlint in a Claude Code session", () => {
  it("confirms the pause to the user only, with the mark anywhere and in any case", async () => {
    project(VIOLATIONS_XML)

    expect(await prompt("Change the label and nothing else. Interlint: PAUSE")).toEqual({
      exitCode: 0,
      stdout: `${JSON.stringify({ systemMessage: PAUSED_MESSAGE })}\n`,
      stderr: "",
    })
  })

  it("runs no check after an edit and ends the task without a check, with a reminder for the user", async () => {
    project(VIOLATIONS_XML)
    await prompt("interlint: pause")

    expect(await edit(ORDER)).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    const stopped = await stop()

    expect(ran()).toBe(false)
    expect(stopped.exitCode).toBe(0)
    expect(systemMessage(stopped.stdout)).toBe(PAUSED_REMINDER)
    expect(PAUSED_REMINDER).toContain("interlint: resume")
  })

  it("runs nothing for the session's subagents either", async () => {
    project(VIOLATIONS_XML, { when: "task-end" })
    await prompt("interlint: pause")
    const subagent = { agent_id: "a1", agent_type: "general-purpose" }

    expect(await edit(ORDER, "class Order {}\n", subagent)).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    const stopped = await claude("subagent-stop", { hook_event_name: "SubagentStop", stop_hook_active: false, ...subagent })

    expect(stopped).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    expect(ran()).toBe(false)
  })

  it("guards no protected file: it neither asks before an edit nor blocks the task end", async () => {
    project(PASSING_XML, { when: "task-end", top: `protected:\n  - "src/test/java/**/arch/**"\n` })
    await claude("session-start", { hook_event_name: "SessionStart" })
    await prompt("interlint: pause")

    const asked = await claude("pre-edit", { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(projectDir, ARCH_TEST) } })
    await edit(ARCH_TEST, "class ArchitectureTest { /* weaker */ }\n")
    const stopped = await stop()

    expect(asked).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    expect(stopped.exitCode).toBe(0)
    expect(systemMessage(stopped.stdout)).toBe(PAUSED_REMINDER)
  })

  it("pauses only its own session: another session is still checked", async () => {
    project(VIOLATIONS_XML, { when: "task-end" })
    await prompt("interlint: pause")
    await edit(ORDER, "class Order {}\n", { session_id: "session-2" })

    const { exitCode, stderr } = await stop(false, { session_id: "session-2" })

    expect(exitCode).toBe(2)
    expect(stderr).toContain("(attempt 1 of 3)")
  })

  it("keeps a pause that is asked again, with the same message", async () => {
    project(PASSING_XML)
    await prompt("interlint: pause")

    expect(systemMessage((await prompt("interlint: pause")).stdout)).toBe(PAUSED_MESSAGE)
    expect(systemMessage((await stop()).stdout)).toBe(PAUSED_REMINDER)
  })
})

describe("resuming Interlint in a Claude Code session", () => {
  it("confirms the resume to the user and checks the agent's next changes", async () => {
    project(VIOLATIONS_XML, { when: "task-end" })
    await prompt("interlint: pause")

    expect(systemMessage((await prompt("all right, interlint: resume")).stdout)).toBe(RESUMED_MESSAGE)
    await edit(ORDER)
    const { exitCode, stderr } = await stop()

    expect(exitCode).toBe(2)
    expect(stderr).toContain("(attempt 1 of 3)")
  })

  it("does not block for the changes made while Interlint was paused", async () => {
    project(PASSING_XML, { when: "task-end" })
    await edit(ORDER)
    expect((await stop()).exitCode).toBe(0)
    await prompt("interlint: pause")
    // A change the agent's checks would reject, made while Interlint was paused.
    writeFile("report.xml", VIOLATIONS_XML)
    await edit(ORDER, "class Order { int broken; }\n")
    forgetRun()

    await prompt("interlint: resume")
    const stopped = await stop()

    expect(stopped).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    expect(ran()).toBe(false)
  })

  it("does not block for a protected file changed while Interlint was paused", async () => {
    project(PASSING_XML, { when: "task-end", top: `protected:\n  - "src/test/java/**/arch/**"\n` })
    await claude("session-start", { hook_event_name: "SessionStart" })
    await prompt("interlint: pause")
    writeFile(ARCH_TEST, "class ArchitectureTest { /* changed while paused */ }\n")

    await prompt("interlint: resume")
    const stopped = await stop()

    expect(stopped.exitCode).toBe(0)
    expect(stopped.stdout).not.toContain("protected")
  })

  it("still blocks for a protected file changed after the resume", async () => {
    project(PASSING_XML, { when: "task-end", top: `protected:\n  - "src/test/java/**/arch/**"\n` })
    await claude("session-start", { hook_event_name: "SessionStart" })
    await prompt("interlint: pause")
    await prompt("interlint: resume")
    writeFile(ARCH_TEST, "class ArchitectureTest { /* changed after the resume */ }\n")

    const { exitCode, stderr } = await stop()

    expect(exitCode).toBe(2)
    expect(stderr).toContain("protected")
  })

  it("starts counting the blocked stops from zero", async () => {
    project(VIOLATIONS_XML, { when: "task-end" })
    await edit(ORDER)
    await stop()
    expect((await stop(true)).stderr).toContain("(attempt 2 of 3)")
    await prompt("interlint: pause")
    await prompt("interlint: resume")
    await edit(ORDER, "class Order { int again; }\n")

    // The agent continues a blocked stop, but the count before the pause is gone.
    const { stderr } = await stop(true)

    expect(stderr).toContain("(attempt 1 of 3)")
  })

  it("starts counting the edits an every check waits for from zero", async () => {
    project(PASSING_XML, { extra: "    every: 2\n" })
    await edit(ORDER)
    expect(ran()).toBe(false)
    await prompt("interlint: pause")
    await prompt("interlint: resume")

    await edit("src/main/java/shop/Customer.java")
    expect(ran()).toBe(false)
    await edit("src/main/java/shop/Invoice.java")
    expect(ran()).toBe(true)
  })

  it("tells the user Interlint was not paused, and changes nothing, when they resume an active session", async () => {
    project(VIOLATIONS_XML, { when: "task-end" })
    await edit(ORDER)
    await stop()

    expect(systemMessage((await prompt("interlint: resume")).stdout)).toBe(NOT_PAUSED_MESSAGE)
    expect((await stop(true)).stderr).toContain("(attempt 2 of 3)")
  })
})

describe("what the agent writes never pauses Interlint", () => {
  it("ignores a mark in a subagent's prompt, which the main agent writes", async () => {
    project(VIOLATIONS_XML)

    expect(await prompt("interlint: pause", { agent_id: "a1", agent_type: "general-purpose" })).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    expect(JSON.parse((await edit(ORDER)).stdout).decision).toBe("block")
  })

  it("ignores a mark in a file the agent writes and in its last message", async () => {
    project(VIOLATIONS_XML, { when: "task-end" })
    await edit(ORDER, "// interlint: pause\nclass Order {}\n")

    const { exitCode } = await stop(false, { last_assistant_message: "Done. interlint: pause" })

    expect(exitCode).toBe(2)
  })
})

describe("without a mark", () => {
  it("leaves the prompt alone and checks as before", async () => {
    project(VIOLATIONS_XML, { when: "task-end" })

    expect(await prompt("Add a discount to the order")).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    await edit(ORDER)
    expect((await stop()).exitCode).toBe(2)
  })
})

describe("the advice to pause after the main agent's last attempt", () => {
  it("goes to the user only after the 3 attempts, never in the blocks the agent reads", async () => {
    project(VIOLATIONS_XML, { when: "task-end" })
    await edit(ORDER)
    const blocks = [await stop(), await stop(true), await stop(true)]

    const last = await stop(true)

    for (const block of blocks) expect(block.stderr).not.toContain("interlint: pause")
    expect(last.exitCode).toBe(0)
    expect(systemMessage(last.stdout)).toMatch(/^Interlint: the checks still fail after 3 attempts, so the task may end\.\n\n✗ architecture/)
    expect(systemMessage(last.stdout)).toContain(`\n\n${PAUSE_ADVICE}`)
  })

  it("is not in a subagent's report, which goes to no user", () => {
    const counter = { read: () => 3, save: () => {}, clear: () => {} }

    const main = decideStop({ sessionId: "s", stopHookActive: true }, "✗ architecture\n", ["architecture"], counter)
    const subagent = decideStop({ sessionId: "s", agentId: "a1", stopHookActive: true }, "✗ architecture\n", ["architecture"], counter)

    expect(main).toEqual({ action: "report", text: `Interlint: the checks still fail after 3 attempts, so the task may end.\n\n✗ architecture\n\n${PAUSE_ADVICE}\n` })
    expect(subagent).toEqual({ action: "report", text: "Interlint: the checks still fail after 3 attempts, so the task may end.\n\n✗ architecture\n" })
  })
})

describe("the metrics of a pause", () => {
  function metricLines(): Record<string, unknown>[] {
    const dir = join(stateDir, "interlint", "metrics")
    if (!existsSync(dir)) return []
    return readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((path) => path.endsWith(".jsonl"))
      .flatMap((path) => readFileSync(join(dir, path), "utf8").trimEnd().split("\n"))
      .map((line) => JSON.parse(line))
  }

  it("keeps each pause and resume with the session, agent and model", async () => {
    project(PASSING_XML)
    const transcript_path = join(stateDir, "session-1.jsonl")
    writeFileSync(transcript_path, `${JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5" } })}\n`)

    await prompt("interlint: pause", { transcript_path })
    await prompt("interlint: pause", { transcript_path })
    await prompt("interlint: resume", { transcript_path })

    expect(metricLines()).toEqual([
      expect.objectContaining({ event: "pause", agent: "claude-code", session: "session-1", model: "claude-opus-5-5", v: 1 }),
      expect.objectContaining({ event: "resume", agent: "claude-code", session: "session-1", model: "claude-opus-5-5" }),
    ])
    expect(metricLines().every(isSessionMetricLine)).toBe(true)
  })

  it("keeps none when the project turns metrics off", async () => {
    project(PASSING_XML, { top: "metrics: false\n" })

    await prompt("interlint: pause")
    await prompt("interlint: resume")

    expect(metricLines()).toEqual([])
  })

  it("leaves them out of the checks' summary without counting them as unreadable", async () => {
    project(PASSING_XML)
    await edit(ORDER)
    await prompt("interlint: pause")
    await prompt("interlint: resume")

    const { exitCode, stdout } = await cli(["metrics"], "")

    expect(exitCode).toBe(0)
    expect(stdout).not.toMatch(/unreadable|could not be read/i)
  })
})

describe("pausing Interlint in a Codex session", () => {
  const codex = (event: string, input: Record<string, unknown> = {}) =>
    cli(["hook", "codex", event], JSON.stringify({ session_id: "codex-1", cwd: projectDir, model: "gpt-6-codex", ...input }))

  it("confirms to the user, runs no check while paused and reminds the user at the task end", async () => {
    project(VIOLATIONS_XML)

    const paused = await codex("user-prompt", { hook_event_name: "UserPromptSubmit", prompt: "interlint: pause" })
    writeFile(ORDER, "class Order {}\n")
    const edited = await codex("post-edit", {
      hook_event_name: "PostToolUse",
      tool_name: "apply_patch",
      tool_input: { command: `*** Begin Patch\n*** Add File: ${ORDER}\n+class Order {}\n*** End Patch\n` },
    })
    const stopped = await codex("stop", { hook_event_name: "Stop", stop_hook_active: false })
    const resumed = await codex("user-prompt", { hook_event_name: "UserPromptSubmit", prompt: "interlint: resume" })

    expect(paused).toEqual({ exitCode: 0, stdout: `${JSON.stringify({ systemMessage: PAUSED_MESSAGE })}\n`, stderr: "" })
    expect(edited).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    expect(systemMessage(stopped.stdout)).toBe(PAUSED_REMINDER)
    expect(systemMessage(resumed.stdout)).toBe(RESUMED_MESSAGE)
    expect(ran()).toBe(false)
  })
})

describe("pausing Interlint in a GitHub Copilot session", () => {
  const copilot = (event: string, input: Record<string, unknown> = {}) =>
    cli(["hook", "copilot", event], JSON.stringify({ sessionId: "copilot-1", cwd: projectDir, timestamp: 1, ...input }))

  it("writes the confirmation to Copilot's log, since Copilot drops a prompt hook's output, and runs no check while paused", async () => {
    project(VIOLATIONS_XML)

    const paused = await copilot("user-prompt", { prompt: "interlint: pause" })
    writeFile(ORDER, "class Order {}\n")
    const edited = await copilot("post-edit", { toolName: "create", toolArgs: { path: join(projectDir, ORDER), file_text: "class Order {}\n" } })
    const stopped = await copilot("stop", { stop_hook_active: false })

    expect(paused).toEqual({ exitCode: 0, stdout: "", stderr: `${PAUSED_MESSAGE}\n` })
    expect(edited).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    expect(stopped).toEqual({ exitCode: 0, stdout: "", stderr: `${PAUSED_REMINDER}\n` })
    expect(ran()).toBe(false)
  })

  it("ignores a mark in a subagent's prompt", async () => {
    project(VIOLATIONS_XML)

    const prompted = await copilot("user-prompt", { prompt: "interlint: pause", agentId: "sub-1", parentAgentId: "copilot-1" })
    writeFile(ORDER, "class Order {}\n")
    const edited = await copilot("post-edit", { toolName: "create", toolArgs: { path: join(projectDir, ORDER), file_text: "class Order {}\n" } })

    expect(prompted).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    expect(JSON.parse(edited.stdout).additionalContext).toContain("Interlint: the checks fail after this edit.")
  })
})
