import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { codexHookFiles } from "../src/adapters/driven/agents/codex-hooks.js"
import { parseCodexHookInput } from "../src/adapters/driving/codex/hook-input.js"
import { main } from "../src/main.js"

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
  projectDir = mkdtempSync(join(tmpdir(), "interlint-codex-"))
  stateDir = mkdtempSync(join(tmpdir(), "interlint-codex-state-"))
  tempDir = mkdtempSync(join(tmpdir(), "interlint-codex-temp-"))
  vi.stubEnv("LOCALAPPDATA", stateDir)
  vi.stubEnv("XDG_STATE_HOME", stateDir)
  for (const name of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(name, tempDir)
  // Codex sets neither: the hooks read the project from the input's cwd.
  vi.stubEnv("CLAUDE_PROJECT_DIR", "")
  vi.stubEnv("COPILOT_PROJECT_DIR", "")
})

afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of [projectDir, stateDir, tempDir]) rmSync(dir, { recursive: true, force: true })
})

/** A check whose report the test can switch between passing and failing. */
function writeCheck(when: "edit" | "task-end", report: string, extra = "") {
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
    `checks:\n  - name: architecture\n    run: node check.mjs\n    report: archunit\n    when: ${when}\n${extra}`,
  )
}

const ORDER = "src/main/java/shop/Order.java"
const ran = () => existsSync(join(projectDir, "target", "ran"))

/** A patch in Codex's `apply_patch` format, from its file sections. */
function patch(...sections: string[][]): string {
  return ["*** Begin Patch", ...sections.flat(), "*** End Patch"].join("\n")
}

const update = (path: string, ...added: string[]) => [`*** Update File: ${path}`, "@@", "-old", ...added.map((line) => `+${line}`)]

/** A `PostToolUse` input as Codex documents it, for its `apply_patch` tool. */
function postToolUse(command: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    session_id: "session-1",
    transcript_path: join(tempDir, "rollout.jsonl"),
    cwd: projectDir,
    hook_event_name: "PostToolUse",
    model: "gpt-6-codex",
    turn_id: "turn-1",
    permission_mode: "default",
    tool_name: "apply_patch",
    tool_use_id: "call_1",
    tool_input: { command },
    tool_response: "Success. Updated the following files:",
    ...extra,
  })
}

function stopInput(stopHookActive: boolean) {
  return JSON.stringify({
    session_id: "session-1",
    transcript_path: null,
    cwd: projectDir,
    hook_event_name: "Stop",
    model: "gpt-6-codex",
    turn_id: "turn-1",
    stop_hook_active: stopHookActive,
    last_assistant_message: "Done.",
  })
}

/** A `SubagentStop` input: the session of the agent that started the subagent, and the subagent's own ID. */
function subagentStopInput(agentId = "writer-1", stopHookActive = false) {
  return JSON.stringify({
    session_id: "session-1",
    transcript_path: null,
    cwd: projectDir,
    hook_event_name: "SubagentStop",
    model: "gpt-6-codex-mini",
    turn_id: "turn-2",
    agent_id: agentId,
    agent_type: "worker",
    agent_transcript_path: null,
    stop_hook_active: stopHookActive,
    last_assistant_message: "Done.",
  })
}

async function hook(event: string, stdin: string, cwd = projectDir) {
  let stdout = ""
  let stderr = ""
  const exitCode = await main(["hook", "codex", event], {
    cwd,
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    stdin: async () => stdin,
  })
  return { exitCode, stdout, stderr }
}

/** The developer context a post-edit hook gives the agent. */
function contextOf(stdout: string): string {
  return JSON.parse(stdout).hookSpecificOutput.additionalContext
}

describe("interlint hook codex post-edit", () => {
  it("runs the edit checks for the files of the patch and gives the agent the failures as context, with exit code 0", async () => {
    writeCheck("edit", VIOLATIONS_XML)

    const { exitCode, stdout, stderr } = await hook("post-edit", postToolUse(patch(update(ORDER, "new"))))

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
    const output = JSON.parse(stdout)
    expect(output.hookSpecificOutput.hookEventName).toBe("PostToolUse")
    expect(output.hookSpecificOutput.additionalContext).toMatch(/^Interlint: the checks fail after this edit\.\n\n✗ architecture · ARCH-01/)
    expect(output.systemMessage).toBe("✗ Interlint · checks failed after this edit: architecture")
    expect(output).not.toHaveProperty("decision")
  })

  it("runs the checks once for a patch that adds one file and updates another", async () => {
    writeCheck("edit", VIOLATIONS_XML)
    const twoFiles = patch(["*** Add File: src/main/java/shop/Invoice.java", "+class Invoice {}"], update("README.md", "docs"))

    expect(contextOf((await hook("post-edit", postToolUse(twoFiles))).stdout)).toContain("ARCH-01")
  })

  it("shows the user the checks that passed, and gives the agent nothing", async () => {
    writeCheck("edit", PASSING_XML)

    const { exitCode, stdout, stderr } = await hook("post-edit", postToolUse(patch(update(ORDER, "new"))))

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
    const output = JSON.parse(stdout)
    expect(Object.keys(output)).toEqual(["systemMessage"])
    expect(output.systemMessage).toMatch(/^✓ Interlint · checks passed: architecture/)
    expect(ran()).toBe(true)
  })

  it("runs nothing for a patch that only deletes files", async () => {
    writeCheck("edit", VIOLATIONS_XML)

    expect(await hook("post-edit", postToolUse(patch([`*** Delete File: ${ORDER}`])))).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    expect(ran()).toBe(false)
  })

  it("runs nothing for a patch that touches no file a check reads", async () => {
    writeCheck("edit", VIOLATIONS_XML)

    expect(await hook("post-edit", postToolUse(patch(update("README.md", "docs"))))).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    expect(ran()).toBe(false)
  })

  it("runs nothing for a tool that is not an edit, such as Bash", async () => {
    writeCheck("edit", VIOLATIONS_XML)
    const bash = postToolUse(patch(update(ORDER, "new")), { tool_name: "Bash" })

    expect(await hook("post-edit", bash)).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    expect(ran()).toBe(false)
  })

  it("adds up the lines a patch writes in every file for a check with lines", async () => {
    writeCheck("edit", PASSING_XML, "    lines: 4\n")

    await hook("post-edit", postToolUse(patch(update(ORDER, "one"))))
    expect(ran()).toBe(false)

    await hook("post-edit", postToolUse(patch(update(ORDER, "two"), ["*** Add File: src/main/java/shop/Invoice.java", "+a", "+b"])))
    expect(ran()).toBe(true)
  })

  it("reads the absolute paths Codex writes in its patches", async () => {
    writeCheck("edit", VIOLATIONS_XML)

    expect(contextOf((await hook("post-edit", postToolUse(patch(update(join(projectDir, ORDER), "new"))))).stdout)).toContain("ARCH-01")
  })

  it("reads the project from the input's cwd, wherever the hook runs", async () => {
    writeCheck("edit", VIOLATIONS_XML)

    expect(contextOf((await hook("post-edit", postToolUse(patch(update(ORDER, "new"))), stateDir)).stdout)).toContain("ARCH-01")
  })

  it("says on stderr why no check ran when an apply_patch input holds no patch it can read, and exits 0", async () => {
    writeCheck("edit", VIOLATIONS_XML)

    const { exitCode, stdout, stderr } = await hook("post-edit", postToolUse("", { tool_input: { changes: {} } }))

    expect({ exitCode, stdout }).toEqual({ exitCode: 0, stdout: "" })
    expect(stderr).toBe("interlint: the apply_patch input has no patch in tool_input.command, so no check ran for this edit\n")
    expect(ran()).toBe(false)
  })

  it("exits 1, never 2, when stdin is not a hook's JSON", async () => {
    const { exitCode, stdout, stderr } = await hook("post-edit", "not json")

    expect({ exitCode, stdout }).toEqual({ exitCode: 1, stdout: "" })
    expect(stderr).toMatch(/^interlint: /)
  })
})

describe("interlint hook codex stop", () => {
  /** The agent changes a file of the project: Codex runs the post-edit hook for it. */
  async function agentEdits() {
    await hook("post-edit", postToolUse(patch(update("README.md", "docs"))))
  }

  function decisionOf(stdout: string): { decision: string; reason: string } {
    return JSON.parse(stdout)
  }

  it("runs nothing when the agent changed nothing since the checks last passed", async () => {
    writeCheck("task-end", VIOLATIONS_XML)

    expect(await hook("stop", stopInput(false))).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    expect(ran()).toBe(false)
  })

  it("blocks with exit code 0 and the failures as the reason on stdout", async () => {
    writeCheck("task-end", VIOLATIONS_XML)
    await agentEdits()

    const { exitCode, stdout, stderr } = await hook("stop", stopInput(false))

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
    const output = decisionOf(stdout)
    expect(Object.keys(output)).toEqual(["decision", "reason"])
    expect(output.decision).toBe("block")
    expect(output.reason).toMatch(
      /^Interlint: the task cannot end yet \(attempt 1 of 3\)\.\n\nFix these failures before you answer: .* Asking the user whether to fix them does not end the task\.\n\n✗ architecture · ARCH-01/,
    )
  })

  it("lets the task end after 3 blocks in a row, and does not block again while Codex keeps continuing", async () => {
    writeCheck("task-end", VIOLATIONS_XML)
    await agentEdits()

    for (const [attempt, active] of [[1, false], [2, true], [3, true]] as const) {
      expect(decisionOf((await hook("stop", stopInput(active))).stdout).reason).toContain(`(attempt ${attempt} of 3)`)
    }
    const fourth = await hook("stop", stopInput(true))
    expect({ exitCode: fourth.exitCode, stderr: fourth.stderr }).toEqual({ exitCode: 0, stderr: "" })
    expect(JSON.parse(fourth.stdout).systemMessage).toContain("the checks still fail after 3 attempts, so the task may end")

    expect(await hook("stop", stopInput(true))).toEqual({ exitCode: 0, stdout: "", stderr: "" })
  })

  it("starts counting again when Codex is not continuing because of a stop hook", async () => {
    writeCheck("task-end", VIOLATIONS_XML)
    await agentEdits()
    await hook("stop", stopInput(false))
    await hook("stop", stopInput(true))

    expect(decisionOf((await hook("stop", stopInput(false))).stdout).reason).toContain("(attempt 1 of 3)")
  })

  it("lets the task end once the checks pass, and shows the user they passed", async () => {
    writeCheck("task-end", VIOLATIONS_XML)
    await agentEdits()
    await hook("stop", stopInput(false))
    writeCheck("task-end", PASSING_XML)

    const { exitCode, stdout, stderr } = await hook("stop", stopInput(true))

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
    const output = JSON.parse(stdout)
    expect(Object.keys(output)).toEqual(["systemMessage"])
    expect(output.systemMessage).toMatch(/^✓ Interlint · checks passed: architecture/)
  })
})

describe("interlint hook codex subagent-stop", () => {
  /** Two projects of a workspace, each with a check whose failure the test picks. */
  function writeWorkspace(failing: { orders: boolean; billing: boolean }) {
    const entries = (["orders", "billing"] as const).map((name) => {
      mkdirSync(join(projectDir, name), { recursive: true })
      writeFileSync(join(projectDir, name, "check.mjs"), `process.exit(${failing[name] ? 1 : 0})\n`)
      return `  - name: ${name}/checkstyle\n    dir: ${name}\n    run: node check.mjs\n    report: maven\n    when: task-end\n`
    })
    writeFileSync(join(projectDir, "interlint.yaml"), `checks:\n${entries.join("")}`)
  }

  /** A subagent patches a file: Codex runs the post-edit hook with the subagent's agent_id. */
  async function subagentEdits(file: string, agentId = "writer-1") {
    await hook("post-edit", postToolUse(patch(update(file, "x")), { agent_id: agentId, agent_type: "worker" }))
  }

  it("runs nothing when a subagent that changed no file stops", async () => {
    writeWorkspace({ orders: true, billing: true })

    expect(await hook("subagent-stop", subagentStopInput())).toEqual({ exitCode: 0, stdout: "", stderr: "" })
  })

  it("blocks a subagent with the failures of only the projects it changed", async () => {
    writeWorkspace({ orders: true, billing: true })
    await subagentEdits("orders/README.md")

    const { exitCode, stdout } = await hook("subagent-stop", subagentStopInput())

    expect(exitCode).toBe(0)
    const { decision, reason } = JSON.parse(stdout)
    expect(decision).toBe("block")
    expect(reason).toContain("Fix these failures yourself before you answer")
    expect(reason).toContain("orders/checkstyle")
    expect(reason).not.toContain("billing/checkstyle")
  })

  it("lets the subagent stop after 3 blocks while Codex keeps it going", async () => {
    writeWorkspace({ orders: true, billing: false })
    await subagentEdits("orders/README.md")

    for (const [attempt, active] of [[1, false], [2, true], [3, true]] as const) {
      expect(JSON.parse((await hook("subagent-stop", subagentStopInput("writer-1", active))).stdout).reason).toContain(
        `(attempt ${attempt} of 3)`,
      )
    }
    const fourth = await hook("subagent-stop", subagentStopInput("writer-1", true))
    expect({ exitCode: fourth.exitCode, stdout: fourth.stdout }).toEqual({ exitCode: 0, stdout: "" })
  })

  it("counts the blocks of each subagent on its own", async () => {
    writeWorkspace({ orders: true, billing: false })
    await subagentEdits("orders/README.md", "writer-1")
    await hook("subagent-stop", subagentStopInput("writer-1"))
    await subagentEdits("orders/README.md", "writer-2")

    expect(JSON.parse((await hook("subagent-stop", subagentStopInput("writer-2", true))).stdout).reason).toContain("(attempt 1 of 3)")
  })

  /** A `SubagentStart` input, as Codex 0.149 gives it: the same session_id and agent_id as the subagent's stop. */
  function subagentStartInput(agentId = "writer-1") {
    return JSON.stringify({
      session_id: "session-1",
      transcript_path: null,
      cwd: projectDir,
      hook_event_name: "SubagentStart",
      model: "gpt-6-codex-mini",
      permission_mode: "default",
      turn_id: "turn-1",
      agent_id: agentId,
      agent_type: "worker",
    })
  }

  it("blocks a subagent that changed a file with a shell command, with the failures of only the projects it changed", async () => {
    writeWorkspace({ orders: true, billing: true })
    expect(await hook("subagent-start", subagentStartInput())).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    // A shell command writes the file: no post-edit hook runs.
    writeFileSync(join(projectDir, "orders", "Order.java"), "class Order {}\n")

    const { exitCode, stdout } = await hook("subagent-stop", subagentStopInput())

    expect(exitCode).toBe(0)
    const { decision, reason } = JSON.parse(stdout)
    expect(decision).toBe("block")
    expect(reason).toContain("orders/checkstyle")
    expect(reason).not.toContain("billing/checkstyle")
  })

  it("gives a subagent that wrote through a shell the same 3 attempts", async () => {
    writeWorkspace({ orders: true, billing: false })
    await hook("subagent-start", subagentStartInput())
    writeFileSync(join(projectDir, "orders", "Order.java"), "class Order {}\n")

    const attempts = [await hook("subagent-stop", subagentStopInput())]
    for (let index = 0; index < 3; index++) attempts.push(await hook("subagent-stop", subagentStopInput("writer-1", true)))

    expect(attempts.map(({ stdout }) => (stdout === "" ? "end" : JSON.parse(stdout).decision ?? "end"))).toEqual(["block", "block", "block", "end"])
  })

  it("runs nothing when a subagent that changed no file, by any means, stops", async () => {
    writeWorkspace({ orders: true, billing: true })
    await hook("subagent-start", subagentStartInput())

    expect(await hook("subagent-stop", subagentStopInput())).toEqual({ exitCode: 0, stdout: "", stderr: "" })
  })

  it("does not check another subagent's shell changes made before it started", async () => {
    writeWorkspace({ orders: true, billing: true })
    await hook("subagent-start", subagentStartInput("writer-1"))
    writeFileSync(join(projectDir, "orders", "Order.java"), "class Order {}\n")
    await hook("subagent-start", subagentStartInput("reviewer-1"))

    expect(await hook("subagent-stop", subagentStopInput("reviewer-1"))).toEqual({ exitCode: 0, stdout: "", stderr: "" })
  })

  it("checks only the files the edit tool changed for a subagent whose start it never saw, as with older hooks", async () => {
    writeWorkspace({ orders: true, billing: true })
    writeFileSync(join(projectDir, "orders", "Order.java"), "class Order {}\n")

    expect(await hook("subagent-stop", subagentStopInput())).toEqual({ exitCode: 0, stdout: "", stderr: "" })
  })
})

describe("the metrics of the Codex hooks", () => {
  function metricLines(): Record<string, unknown>[] {
    const dir = join(stateDir, "interlint", "metrics")
    if (!existsSync(dir)) return []
    return readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((path) => path.endsWith(".jsonl"))
      .flatMap((path) => readFileSync(join(dir, path), "utf8").trimEnd().split("\n"))
      .map((line) => JSON.parse(line))
  }

  it("keeps agent codex, the session and the model the input gives", async () => {
    writeCheck("edit", PASSING_XML)

    await hook("post-edit", postToolUse(patch(update(ORDER, "new"))))

    const [line] = metricLines()
    expect(line).toMatchObject({ when: "edit", check: "architecture", agent: "codex", session: "session-1", model: "gpt-6-codex" })
    expect(line).not.toHaveProperty("subagent")
  })

  it("keeps a subagent's type and model for its stop", async () => {
    writeCheck("task-end", PASSING_XML)
    await hook("post-edit", postToolUse(patch(update(ORDER, "new")), { agent_id: "a1", agent_type: "worker" }))

    await hook("subagent-stop", subagentStopInput("a1"))

    expect(metricLines().at(-1)).toMatchObject({
      when: "task-end",
      agent: "codex",
      session: "session-1",
      subagent: true,
      agentType: "worker",
      model: "gpt-6-codex-mini",
    })
  })
})

describe("parseCodexHookInput", () => {
  it("reads every file a patch adds, updates or moves, and leaves deleted files out", () => {
    const command = patch(
      ["*** Add File: src/A.java", "+class A {}", "+"],
      update("src/B.java", "new"),
      ["*** Delete File: src/C.java"],
      ["*** Update File: src/Old.java", "+one", "*** Move to: src/New.java", "+two"],
    )

    expect(parseCodexHookInput(postToolUse(command)).edits).toEqual([
      { path: "src/A.java", linesWritten: 2 },
      { path: "src/B.java", linesWritten: 1 },
      { path: "src/New.java", linesWritten: 2 },
    ])
  })

  it("reads the file of an Edit or Write in Claude Code's format", () => {
    const edit = postToolUse("", { tool_name: "Edit", tool_input: { file_path: "src/A.java", old_string: "a", new_string: "b\nc" } })
    const write = postToolUse("", { tool_name: "Write", tool_input: { file_path: "src/B.java", content: "x\ny\nz\n" } })

    expect(parseCodexHookInput(edit).edits).toEqual([{ path: "src/A.java", linesWritten: 2 }])
    expect(parseCodexHookInput(write).edits).toEqual([{ path: "src/B.java", linesWritten: 3 }])
  })

  it("reads the session, the subagent, stop_hook_active and the model", () => {
    expect(parseCodexHookInput(subagentStopInput("a1", true))).toEqual({
      sessionId: "session-1",
      cwd: projectDir,
      edits: [],
      stopHookActive: true,
      agentId: "a1",
      agentType: "worker",
      model: "gpt-6-codex-mini",
      unreadablePatch: false,
    })
  })

  it("reads a patch given as input, patch or the whole tool input", () => {
    const command = patch(update("src/A.java", "new"))
    const edits = [{ path: "src/A.java", linesWritten: 1 }]

    for (const toolInput of [{ input: command }, { patch: command }, command]) {
      expect(parseCodexHookInput(postToolUse("", { tool_input: toolInput }))).toMatchObject({ edits, unreadablePatch: false })
    }
  })
})

describe("interlint hook codex", () => {
  it("exits 1 for an unknown event, so a typo never blocks the agent", async () => {
    const { exitCode, stderr } = await hook("post-commit", "{}")

    expect(exitCode).toBe(1)
    expect(stderr).toContain("codex hooks are session-start, user-prompt, post-edit, stop, subagent-start and subagent-stop")
  })

  it("writes hooks that run interlint hook codex for each event", () => {
    const [file] = codexHookFiles(projectDir)
    const { hooks } = JSON.parse(file?.content ?? "{}")

    expect(hooks.PostToolUse[0]).toEqual({
      matcher: "apply_patch|Edit|Write",
      hooks: [
        { type: "command", command: "interlint hook codex post-edit", timeout: 120, statusMessage: "Interlint: running checks" },
      ],
    })
    expect(hooks.Stop[0].hooks[0].command).toBe("interlint hook codex stop")
    expect(hooks.SubagentStart[0].hooks[0].command).toBe("interlint hook codex subagent-start")
    expect(hooks.SubagentStop[0].hooks[0].command).toBe("interlint hook codex subagent-stop")
  })
})
