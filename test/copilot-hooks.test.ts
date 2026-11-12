import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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
  projectDir = mkdtempSync(join(tmpdir(), "interlint-copilot-"))
  stateDir = mkdtempSync(join(tmpdir(), "interlint-copilot-state-"))
  tempDir = mkdtempSync(join(tmpdir(), "interlint-copilot-temp-"))
  vi.stubEnv("LOCALAPPDATA", stateDir)
  vi.stubEnv("XDG_STATE_HOME", stateDir)
  for (const name of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(name, tempDir)
  // As Copilot runs its hooks: it sets both variables, and COPILOT_CLI.
  vi.stubEnv("COPILOT_CLI", "1")
  vi.stubEnv("COPILOT_PROJECT_DIR", projectDir)
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

const JAVA_FILE = () => join(projectDir, "src", "main", "java", "shop", "Order.java")
const ran = () => existsSync(join(projectDir, "target", "ran"))

/**
 * What Copilot puts in the input of a hook that fires inside subagent `agentId`: the subagent's ID as `sessionId`, and
 * the session as `parentAgentId`.
 */
function inSubagent(agentId: string) {
  return { sessionId: agentId, agentId, agentType: "general-purpose", parentAgentId: "session-1" }
}

/** A `postToolUse` input as Copilot gives it, for its `edit` tool unless `extra` says otherwise. */
function postToolUse(path: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    sessionId: "session-1",
    timestamp: 1794468825412,
    cwd: projectDir,
    toolCallId: "call_1",
    toolName: "edit",
    toolArgs: { path, old_str: "a", new_str: "b" },
    toolResult: { resultType: "success", textResultForLlm: `File ${path} updated with changes.` },
    ...extra,
  })
}

function agentStop(stopHookActive: boolean, sessionId = "session-1") {
  return JSON.stringify({
    sessionId,
    timestamp: 1794468827107,
    cwd: projectDir,
    transcriptPath: join(tempDir, "events.jsonl"),
    stopReason: "end_turn",
    stop_hook_active: stopHookActive,
  })
}

/** A `subagentStop` input, as Copilot gives it: the session in `sessionId` and `parentAgentId`. */
function subagentStopInput(agentId = "writer-1", extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    sessionId: "session-1",
    timestamp: 1794468830000,
    cwd: projectDir,
    agentId,
    parentAgentId: "session-1",
    stop_hook_active: false,
    agentType: "general-purpose",
    agentName: "writer",
    response: "Done.",
    stopReason: "end_turn",
    ...extra,
  })
}

async function hook(event: string, stdin: string, cwd = projectDir) {
  let stdout = ""
  let stderr = ""
  const exitCode = await main(["hook", "copilot", event], {
    cwd,
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    stdin: async () => stdin,
  })
  return { exitCode, stdout, stderr }
}

describe("interlint hook copilot post-edit", () => {
  it("runs the edit checks for the edited file and gives the agent the failures as context, with exit code 0", async () => {
    writeCheck("edit", VIOLATIONS_XML)

    const { exitCode, stdout, stderr } = await hook("post-edit", postToolUse(JAVA_FILE()))

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
    const output = JSON.parse(stdout)
    expect(Object.keys(output)).toEqual(["additionalContext"])
    expect(output.additionalContext).toMatch(/^Interlint: the checks fail after this edit\.\n\n✗ architecture · ARCH-01/)
    expect(output.additionalContext).toContain("Fix these problems before continuing.")
  })

  it("answers nothing when the checks pass", async () => {
    writeCheck("edit", PASSING_XML)

    expect(await hook("post-edit", postToolUse(JAVA_FILE()))).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    expect(ran()).toBe(true)
  })

  it("runs nothing for a tool that changes no file, such as view", async () => {
    writeCheck("edit", VIOLATIONS_XML)

    const view = postToolUse(JAVA_FILE(), { toolName: "view", toolArgs: { path: JAVA_FILE() } })
    expect(await hook("post-edit", view)).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    expect(ran()).toBe(false)
  })

  it("runs nothing for a file that no check reads", async () => {
    writeCheck("edit", VIOLATIONS_XML)

    expect(await hook("post-edit", postToolUse(join(projectDir, "README.md")))).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    expect(ran()).toBe(false)
  })

  it("reads the file of create, and the arguments when Copilot gives them as a JSON string", async () => {
    writeCheck("edit", VIOLATIONS_XML)
    const create = postToolUse(JAVA_FILE(), {
      toolName: "create",
      toolArgs: JSON.stringify({ path: JAVA_FILE(), file_text: "class Order {}\n" }),
    })

    expect(JSON.parse((await hook("post-edit", create)).stdout).additionalContext).toContain("ARCH-01")
  })

  it("reads the files a patch adds or updates", async () => {
    writeCheck("edit", VIOLATIONS_XML)
    const patch = ["*** Begin Patch", "*** Update File: src/main/java/shop/Order.java", "@@", "-a", "+b", "*** End Patch"].join("\n")

    const { stdout } = await hook("post-edit", postToolUse(JAVA_FILE(), { toolName: "apply_patch", toolArgs: patch }))

    expect(JSON.parse(stdout).additionalContext).toContain("ARCH-01")
  })

  it("counts the lines each edit or create writes for a check with lines, and runs it once they reach it", async () => {
    writeCheck("edit", PASSING_XML)
    writeFileSync(join(projectDir, "interlint.yaml"), `${readFileSync(join(projectDir, "interlint.yaml"), "utf8")}    lines: 5\n`)

    const logLine = { path: JAVA_FILE(), old_str: "    pay();", new_str: '    log.info("pay");\n    pay();' }
    await hook("post-edit", postToolUse(JAVA_FILE(), { toolArgs: logLine }))
    expect(ran()).toBe(false)

    const newClass = { path: JAVA_FILE(), file_text: "class Order {\n  int id;\n  int total;\n}\n" }
    await hook("post-edit", postToolUse(JAVA_FILE(), { toolName: "create", toolArgs: newClass }))
    expect(ran()).toBe(true)
  })

  it("uses the input's cwd when COPILOT_PROJECT_DIR is not set", async () => {
    vi.stubEnv("COPILOT_PROJECT_DIR", "")
    writeCheck("edit", VIOLATIONS_XML)

    expect(JSON.parse((await hook("post-edit", postToolUse(JAVA_FILE()), stateDir)).stdout).additionalContext).toContain("ARCH-01")
  })

  it("exits 1, which Copilot only logs, when stdin is not a hook's JSON", async () => {
    const { exitCode, stdout, stderr } = await hook("post-edit", "not json")

    expect({ exitCode, stdout }).toEqual({ exitCode: 1, stdout: "" })
    expect(stderr).toMatch(/^interlint: /)
  })
})

describe("interlint hook copilot stop", () => {
  /** The agent changes a file of the project: Copilot runs the post-edit hook for it. */
  async function agentEdits() {
    await hook("post-edit", postToolUse(join(projectDir, "README.md")))
  }

  /** The decision of a stop hook, read from its JSON on stdout. */
  function decisionOf(stdout: string): { decision: string; reason: string } {
    return JSON.parse(stdout)
  }

  it("runs nothing when the agent changed nothing since the checks last passed", async () => {
    writeCheck("task-end", VIOLATIONS_XML)

    expect(await hook("stop", agentStop(false))).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    expect(ran()).toBe(false)
  })

  it("blocks with exit code 0 and the failures as the reason on stdout", async () => {
    writeCheck("task-end", VIOLATIONS_XML)
    await agentEdits()

    const { exitCode, stdout, stderr } = await hook("stop", agentStop(false))

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
    const output = decisionOf(stdout)
    expect(output.decision).toBe("block")
    expect(output.reason).toMatch(/^Interlint: the task cannot end yet \(attempt 1 of 3\)\.\n\n✗ architecture · ARCH-01/)
  })

  it("lets the task end after 3 blocks in a row, and does not block again while Copilot keeps continuing", async () => {
    writeCheck("task-end", VIOLATIONS_XML)
    await agentEdits()

    for (const [attempt, active] of [[1, false], [2, true], [3, true]] as const) {
      expect(decisionOf((await hook("stop", agentStop(active))).stdout).reason).toContain(`(attempt ${attempt} of 3)`)
    }
    const fourth = await hook("stop", agentStop(true))
    expect({ exitCode: fourth.exitCode, stdout: fourth.stdout }).toEqual({ exitCode: 0, stdout: "" })
    expect(fourth.stderr).toContain("the checks still fail after 3 attempts, so the task may end")

    expect(await hook("stop", agentStop(true))).toEqual({ exitCode: 0, stdout: "", stderr: "" })
  })

  it("starts counting again when Copilot is not continuing because of a stop hook", async () => {
    writeCheck("task-end", VIOLATIONS_XML)
    await agentEdits()
    await hook("stop", agentStop(false))
    await hook("stop", agentStop(true))

    expect(decisionOf((await hook("stop", agentStop(false))).stdout).reason).toContain("(attempt 1 of 3)")
  })

  it("runs nothing for the agentStop Copilot also fires when a subagent ends: subagent-stop checks its files", async () => {
    writeCheck("task-end", VIOLATIONS_XML)
    await agentEdits()
    const subagentEnds = JSON.stringify({ ...JSON.parse(agentStop(false)), ...inSubagent("writer-1") })

    expect(await hook("stop", subagentEnds)).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    expect(ran()).toBe(false)
  })

  it("lets the task end once the checks pass", async () => {
    writeCheck("task-end", VIOLATIONS_XML)
    await agentEdits()
    await hook("stop", agentStop(false))
    writeCheck("task-end", PASSING_XML)

    const { exitCode, stdout, stderr } = await hook("stop", agentStop(true))

    expect({ exitCode, stdout }).toEqual({ exitCode: 0, stdout: "" })
    expect(stderr).toMatch(/✓ Interlint · checks passed: architecture/)
  })
})

describe("interlint hook copilot subagent-stop", () => {
  /** Two projects of a workspace, each with a check whose failure the test picks. */
  function writeWorkspace(failing: { orders: boolean; billing: boolean }) {
    const entries = (["orders", "billing"] as const).map((name) => {
      mkdirSync(join(projectDir, name), { recursive: true })
      writeFileSync(join(projectDir, name, "check.mjs"), `process.exit(${failing[name] ? 1 : 0})\n`)
      return `  - name: ${name}/checkstyle\n    dir: ${name}\n    run: node check.mjs\n    report: maven\n    when: task-end\n`
    })
    writeFileSync(join(projectDir, "interlint.yaml"), `checks:\n${entries.join("")}`)
  }

  /** A subagent edits a file: Copilot runs the post-edit hook with the subagent's agentId. */
  async function subagentEdits(file: string, agentId = "writer-1") {
    await hook("post-edit", postToolUse(join(projectDir, file), inSubagent(agentId)))
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

  it("lets the subagent stop after 3 blocks, though Copilot gives a subagent's stop stop_hook_active false", async () => {
    writeWorkspace({ orders: true, billing: false })
    await subagentEdits("orders/README.md")

    for (const attempt of [1, 2, 3]) {
      expect(JSON.parse((await hook("subagent-stop", subagentStopInput())).stdout).reason).toContain(`(attempt ${attempt} of 3)`)
    }
    const fourth = await hook("subagent-stop", subagentStopInput())
    expect({ exitCode: fourth.exitCode, stdout: fourth.stdout }).toEqual({ exitCode: 0, stdout: "" })
  })

  it("counts the blocks of each subagent on its own", async () => {
    writeWorkspace({ orders: true, billing: false })
    await subagentEdits("orders/README.md", "writer-1")
    await hook("subagent-stop", subagentStopInput("writer-1"))
    await subagentEdits("orders/README.md", "writer-2")

    expect(JSON.parse((await hook("subagent-stop", subagentStopInput("writer-2"))).stdout).reason).toContain("(attempt 1 of 3)")
  })
})

describe("the metrics of the Copilot hooks", () => {
  function metricLines(): Record<string, unknown>[] {
    const dir = join(stateDir, "interlint", "metrics")
    if (!existsSync(dir)) return []
    return readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((path) => path.endsWith(".jsonl"))
      .flatMap((path) => readFileSync(join(dir, path), "utf8").trimEnd().split("\n"))
      .map((line) => JSON.parse(line))
  }

  /** A session's `events.jsonl` whose last answer came from `model`, as Copilot writes it. */
  function writeEvents(model: string): string {
    const path = join(tempDir, "events.jsonl")
    const events = [
      { type: "session.model_change", data: { newModel: "auto" } },
      { type: "assistant.message", data: { model: "earlier-model", content: "" } },
      { type: "assistant.message", data: { model, content: "Done." } },
      { type: "hook.start", data: { hookType: "postToolUse" } },
    ]
    writeFileSync(path, events.map((event) => `${JSON.stringify(event)}\n`).join(""))
    return path
  }

  it("keeps agent copilot, the session and the model of an edit", async () => {
    writeCheck("edit", PASSING_XML)

    await hook("post-edit", postToolUse(JAVA_FILE(), { transcriptPath: writeEvents("mai-code-1.1-flash") }))

    const [line] = metricLines()
    expect(line).toMatchObject({ when: "edit", check: "architecture", agent: "copilot", session: "session-1", model: "mai-code-1.1-flash" })
    expect(line).not.toHaveProperty("subagent")
  })

  it("keeps agent copilot for a stop, and a subagent's type without a model it cannot tell apart", async () => {
    writeCheck("task-end", PASSING_XML)
    const transcriptPath = writeEvents("mai-code-1.1-flash")
    await hook("post-edit", postToolUse(JAVA_FILE(), { ...inSubagent("a1"), transcriptPath }))

    await hook("subagent-stop", subagentStopInput("a1", { transcriptPath }))

    const line = metricLines().at(-1)
    expect(line).toMatchObject({ when: "task-end", agent: "copilot", subagent: true, agentType: "general-purpose" })
    expect(line).not.toHaveProperty("model")
  })
})

describe("interlint hook copilot", () => {
  it("exits 1 for an unknown event, so a typo never blocks the agent", async () => {
    const { exitCode, stderr } = await hook("post-commit", "{}")

    expect(exitCode).toBe(1)
    expect(stderr).toContain("copilot hooks are post-edit, stop and subagent-stop")
  })
})
