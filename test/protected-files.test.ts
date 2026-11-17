import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { diskProtectedFiles } from "../src/adapters/driven/fs/protected-files.js"
import { loadConfig } from "../src/adapters/driven/yaml-config/config.js"
import { ConfigError } from "../src/application/checking/ports.js"
import { isProtected, protectedChanges, withApprovedEdits } from "../src/domain/protected-files.js"
import { main } from "../src/main.js"

const VIOLATIONS_XML = readFileSync(join(import.meta.dirname, "fixtures", "surefire", "two-rules-violated.xml"), "utf8")
const PASSING_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="ArchitectureRulesTest" tests="1"><testcase name="DOMAIN_IS_PURE" classname="ArchitectureRulesTest"/></testsuite>`

const ARCH_TEST = "src/test/java/shop/arch/ArchitectureTest.java"
const CHECKSTYLE = "config/checkstyle.xml"
const CONFIG = (extra = "") =>
  `checks:\n  - name: architecture\n    run: node check.mjs\n    report: archunit\n    when: task-end\n${extra}`
const PROTECTED = `protected:\n  - "src/test/java/**/arch/**"\n  - ${CHECKSTYLE}\n`

let projectDir: string
let stateDir: string

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "interlint-protected-"))
  stateDir = mkdtempSync(join(tmpdir(), "interlint-protected-state-"))
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

/** A project whose check passes unless it is given a failing report, so only the protected files can block. */
function project(config = CONFIG(PROTECTED), report = PASSING_XML) {
  writeFile(
    "check.mjs",
    `import { mkdirSync, writeFileSync } from "node:fs"
mkdirSync("target/surefire-reports", { recursive: true })
writeFileSync("target/surefire-reports/TEST-ArchitectureRulesTest.xml", ${JSON.stringify(report)})
process.exit(${report.includes("<failure") ? 1 : 0})
`,
  )
  writeFile("interlint.yaml", config)
  writeFile(ARCH_TEST, "class ArchitectureTest {}\n")
  writeFile(CHECKSTYLE, "<module name=\"Checker\"/>\n")
}

async function cli(args: string[], stdin = "") {
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

const claudeEdit = (path: string) => ({
  tool_name: "Edit",
  tool_input: { file_path: join(projectDir, path), old_string: "a", new_string: "b" },
})

const claudeStop = () => claude("stop", { hook_event_name: "Stop", stop_hook_active: false })

function metricLines(): Record<string, unknown>[] {
  const root = join(stateDir, "interlint", "metrics")
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".jsonl"))
    .flatMap((path) => readFileSync(join(root, path), "utf8").split("\n").filter((line) => line !== ""))
    .map((line) => JSON.parse(line))
}

describe("protected file patterns", () => {
  it("match paths and globs relative to interlint.yaml, without case", () => {
    const patterns = ["src/test/java/**/arch/**", "config/checkstyle.xml", "*.eslintrc.json", "interlint.yaml"]

    expect(isProtected("src/test/java/shop/arch/ArchitectureTest.java", patterns)).toBe(true)
    expect(isProtected("src/test/java/arch/Rules.java", patterns)).toBe(true)
    expect(isProtected("Config/Checkstyle.xml", patterns)).toBe(true)
    expect(isProtected("app.eslintrc.json", patterns)).toBe(true)
    expect(isProtected("interlint.yaml", patterns)).toBe(true)
    expect(isProtected("src/test/java/shop/OrderTest.java", patterns)).toBe(false)
    expect(isProtected("sub/app.eslintrc.json", patterns)).toBe(false)
  })

  it("tell changed and deleted files apart, and leave out a file new since the fingerprint", () => {
    expect(protectedChanges({ a: "1", b: "2", c: "3" }, { a: "1", b: "9", d: "4" })).toEqual({ changed: ["b"], deleted: ["c"] })
  })

  it("renew only the edited files when an edit is approved", () => {
    expect(withApprovedEdits({ a: "1", b: "2" }, { a: "8", b: "9", c: "3" }, ["B", "c"])).toEqual({ a: "1", b: "9", c: "3" })
  })

  it("hash the files a glob matches, skipping node_modules, and a literal path read directly", () => {
    project()
    writeFile("node_modules/pkg/arch/x.js", "x")

    const fingerprint = diskProtectedFiles(projectDir, ["interlint.yaml", "**/arch/**", CHECKSTYLE, "missing.xml"])

    expect(Object.keys(fingerprint).sort()).toEqual([CHECKSTYLE, "interlint.yaml", ARCH_TEST].sort())
  })
})

describe("protected: in interlint.yaml", () => {
  it("is read as a list of paths and globs", () => {
    project(CONFIG('protected:\n  - "./src/test/java/**/arch/**"\n  - config\\\\checkstyle.xml\n'))

    expect(loadConfig(projectDir).protected).toEqual(["src/test/java/**/arch/**", "config/checkstyle.xml"])
  })

  it("is absent when not given", () => {
    project(CONFIG())

    expect(loadConfig(projectDir).protected).toBeUndefined()
  })

  it.each([
    ["protected: checkstyle.xml\n", "protected must be a list of paths or globs"],
    ["protected:\n  - ../other/rules.xml\n", 'protected[0] must be a path or glob inside the project, relative to interlint.yaml (got "../other/rules.xml")'],
    ["protected:\n  - /etc/rules.xml\n", "protected[0] must be a path or glob inside the project"],
    ["protected:\n  - 3\n", "protected[0] must be a path or glob inside the project"],
  ])("rejects %j", (extra, message) => {
    project(CONFIG(extra))

    expect(() => loadConfig(projectDir)).toThrow(ConfigError)
    expect(() => loadConfig(projectDir)).toThrow(message)
  })
})

describe("protected files in Claude Code", () => {
  it("blocks the task end when a protected file changed since the session started, from the terminal too, and names it", async () => {
    project()
    expect(await claude("session-start", { hook_event_name: "SessionStart", source: "startup" })).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    })
    // Changed without the edit tool, as `sed` would.
    writeFile(ARCH_TEST, "class ArchitectureTest { /* weaker */ }\n")

    const { exitCode, stderr } = await claudeStop()

    expect(exitCode).toBe(2)
    expect(stderr).toContain("Interlint: the task cannot end yet (attempt 1 of 3).")
    expect(stderr).toContain("✗ protected files · changed without the user's approval")
    expect(stderr).toContain(`  ${ARCH_TEST} (changed)`)
    expect(stderr).toContain("Undo the change: put each file back as it was.")
    expect(stderr).toContain("If the task needs the change, make it with your edit tool: the user is asked to approve it.")
    // The protected files' failure says what to do itself: the note for failed checks would contradict it.
    expect(stderr).not.toContain("Fix these failures before you answer")
  })

  it("blocks for a deleted protected file, not for a new file a glob matches", async () => {
    project()
    await claude("session-start")
    rmSync(join(projectDir, CHECKSTYLE))
    writeFile("src/test/java/shop/arch/NewRules.java", "class NewRules {}\n")

    const { exitCode, stderr } = await claudeStop()

    expect(exitCode).toBe(2)
    expect(stderr).toContain(`  ${CHECKSTYLE} (deleted)`)
    expect(stderr).not.toContain("NewRules.java")
  })

  it("lets the task end once the file is back as it was", async () => {
    project()
    await claude("session-start")
    writeFile(ARCH_TEST, "changed\n")
    expect((await claudeStop()).exitCode).toBe(2)
    writeFile(ARCH_TEST, "class ArchitectureTest {}\n")

    const { exitCode, stderr } = await claudeStop()

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
  })

  it("protects interlint.yaml without protected:", async () => {
    project(CONFIG())
    await claude("session-start")
    writeFile("interlint.yaml", `${CONFIG()}metrics: false\n`)

    const { exitCode, stderr } = await claudeStop()

    expect(exitCode).toBe(2)
    expect(stderr).toContain("  interlint.yaml (changed)")
  })

  it("keeps the first fingerprint of a session when it resumes", async () => {
    project()
    await claude("session-start", { source: "startup" })
    writeFile(ARCH_TEST, "changed\n")
    await claude("session-start", { source: "resume" })

    expect((await claudeStop()).exitCode).toBe(2)
  })

  it("asks the user before an edit changes a protected file, and lets other edits through", async () => {
    project()

    const asked = await claude("pre-edit", { hook_event_name: "PreToolUse", ...claudeEdit(ARCH_TEST) })
    const other = await claude("pre-edit", { hook_event_name: "PreToolUse", ...claudeEdit("src/main/java/shop/Order.java") })

    expect(asked.exitCode).toBe(0)
    expect(JSON.parse(asked.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: `Interlint: the agent wants to change ${ARCH_TEST}, protected in interlint.yaml because it defines the project's rules. Allow it only if the task needs this change.`,
      },
    })
    expect(other).toEqual({ exitCode: 0, stdout: "", stderr: "" })
  })

  it("takes an edit that ran after the user approved it as the new reference", async () => {
    project()
    await claude("session-start")
    writeFile(ARCH_TEST, "class ArchitectureTest { /* a new rule */ }\n")

    const edit = await claude("post-edit", { hook_event_name: "PostToolUse", ...claudeEdit(ARCH_TEST) })
    const stop = await claudeStop()

    expect(edit.stdout).not.toContain("protected files")
    expect(stop.exitCode).toBe(0)
  })

  it("does not check protected files at a subagent's stop", async () => {
    project()
    await claude("session-start")
    writeFile(ARCH_TEST, "changed\n")

    const { exitCode } = await claude("subagent-stop", { agent_id: "agent-1", stop_hook_active: false })

    expect(exitCode).toBe(0)
  })

  it("keeps which protected file changed, the agent and the model in the metrics", async () => {
    project()
    const transcript = join(projectDir, "transcript.jsonl")
    writeFileSync(transcript, `${JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5" } })}\n`)
    await claude("session-start")
    writeFile(ARCH_TEST, "changed\n")
    rmSync(join(projectDir, CHECKSTYLE))

    await claude("stop", { stop_hook_active: false, transcript_path: transcript })

    const event = metricLines().find((line) => line.check === "protected files")
    expect(event).toMatchObject({
      when: "task-end",
      report: "protected",
      result: "violations",
      agent: "claude-code",
      session: "session-1",
      model: "claude-opus-5-5",
      violations: [
        { rule: "protected file changed", file: ARCH_TEST },
        { rule: "protected file deleted", file: CHECKSTYLE },
      ],
    })
  })

  it("gives the same output as before without protected: and with interlint.yaml unchanged", async () => {
    project(CONFIG())
    await claude("session-start")
    writeFile(ARCH_TEST, "changed\n")

    const stop = await claudeStop()
    const edit = await claude("post-edit", claudeEdit(ARCH_TEST))

    expect(stop.exitCode).toBe(0)
    expect(stop.stderr).toBe("")
    expect(edit).toEqual({ exitCode: 0, stdout: "", stderr: "" })
  })

  it("checks no protected file when the session never started, as with hooks from an older init", async () => {
    project()
    writeFile(ARCH_TEST, "changed\n")

    expect((await claudeStop()).exitCode).toBe(0)
  })
})

describe("protected files in Codex", () => {
  const codex = (event: string, input: Record<string, unknown> = {}) =>
    cli(["hook", "codex", event], JSON.stringify({ session_id: "codex-1", cwd: projectDir, model: "gpt-6-codex", ...input }))
  const patch = (path: string) => ({
    tool_name: "apply_patch",
    tool_input: { command: `*** Begin Patch\n*** Update File: ${path}\n@@\n-a\n+b\n*** End Patch\n` },
  })

  it("warns the agent right after its edit changed a protected file, and the task end still blocks", async () => {
    project()
    await codex("session-start", { source: "startup" })
    writeFile(ARCH_TEST, "changed\n")

    const edit = await codex("post-edit", { hook_event_name: "PostToolUse", ...patch(ARCH_TEST) })
    const stop = await codex("stop", { stop_hook_active: false })

    const context = JSON.parse(edit.stdout).hookSpecificOutput.additionalContext
    expect(context).toContain("✗ protected files · this edit changed a file that defines the project's rules")
    expect(context).toContain(`  ${ARCH_TEST}`)
    expect(JSON.parse(edit.stdout).systemMessage).toBe("✗ Interlint · checks failed after this edit: protected files")
    const block = JSON.parse(stop.stdout)
    expect(block.decision).toBe("block")
    expect(block.reason).toContain(`  ${ARCH_TEST} (changed)`)
    expect(block.reason).toContain("If the task needs the change, ask the user whether they want it.")
  })

  it("keeps the instructions of the protected files apart when a check fails too", async () => {
    project(CONFIG(PROTECTED), VIOLATIONS_XML)
    await codex("session-start", { source: "startup" })
    writeFile(ARCH_TEST, "changed\n")
    // An edit marks the project as changed, so its checks run at task end.
    await codex("post-edit", { hook_event_name: "PostToolUse", ...patch("README.md") })

    const { reason } = JSON.parse((await codex("stop", { stop_hook_active: false })).stdout)

    // The note for the failed checks must not undo "ask the user", which the protected files' message says.
    expect(reason).toContain(
      "Asking the user whether to fix them does not end the task. The protected files are a separate case: follow the instructions in their own message.\n\n✗ protected files · changed without the user's approval",
    )
    expect(reason).toContain("If the task needs the change, ask the user whether they want it.")
    expect(reason).toContain("✗ architecture · ARCH-01")
  })

  it("does not warn about a new file a glob matches: it cannot block the task end", async () => {
    project()
    await codex("session-start")
    writeFile("src/test/java/shop/arch/NewRules.java", "class NewRules {}\n")

    const edit = await codex("post-edit", patch("src/test/java/shop/arch/NewRules.java"))

    expect(edit.stdout).not.toContain("protected files")
  })

  it("has no pre-edit hook: Codex hooks cannot ask the user", async () => {
    project()

    const { exitCode, stderr } = await codex("pre-edit", patch(ARCH_TEST))

    expect(exitCode).toBe(1)
    expect(stderr).toContain("codex hooks are session-start, user-prompt, post-edit, stop and subagent-stop")
  })
})

describe("protected files in GitHub Copilot", () => {
  const copilot = (event: string, input: Record<string, unknown> = {}) =>
    cli(["hook", "copilot", event], JSON.stringify({ sessionId: "copilot-1", cwd: projectDir, timestamp: 1, ...input }))

  it("asks the user before an edit changes a protected file", async () => {
    project()

    const { exitCode, stdout } = await copilot("pre-edit", {
      toolName: "edit",
      toolArgs: JSON.stringify({ path: join(projectDir, CHECKSTYLE), old_str: "a", new_str: "b" }),
    })

    expect(exitCode).toBe(0)
    expect(JSON.parse(stdout)).toEqual({
      permissionDecision: "ask",
      permissionDecisionReason: `Interlint: the agent wants to change ${CHECKSTYLE}, protected in interlint.yaml because it defines the project's rules. Allow it only if the task needs this change.`,
    })
  })

  it("blocks the task end for a protected file changed from the terminal", async () => {
    project()
    await copilot("session-start", { source: "new" })
    writeFile(CHECKSTYLE, "<module name=\"Weaker\"/>\n")

    const { stdout } = await copilot("stop", { stop_hook_active: false })

    expect(JSON.parse(stdout).reason).toContain(`  ${CHECKSTYLE} (changed)`)
  })
})

describe("interlint check, as the OpenCode plugin runs it for protected files", () => {
  const context = JSON.stringify({ agent: "opencode", session: "oc-1" })

  it("prints the question for the user at pre-edit when a file is protected, and nothing otherwise", async () => {
    project()

    const guarded = await cli(["check", "--when", "pre-edit", "--file", join(projectDir, ARCH_TEST)])
    const free = await cli(["check", "--when", "pre-edit", "--file", "src/main/java/shop/Order.java"])

    expect(guarded.exitCode).toBe(0)
    expect(guarded.stdout).toBe(
      `Interlint: the agent wants to change ${ARCH_TEST}, protected in interlint.yaml because it defines the project's rules. Allow it only if the task needs this change.\n`,
    )
    expect(free).toEqual({ exitCode: 0, stdout: "", stderr: "" })
  })

  it("keeps the fingerprint at session-start, renews it for an edit OpenCode asked about, and blocks the task end otherwise", async () => {
    project()
    expect(await cli(["check", "--when", "session-start", "--agent-context"], context)).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    })
    writeFile(ARCH_TEST, "approved\n")
    await cli(["check", "--when", "edit", "--asked", "--file", ARCH_TEST, "--agent-context"], context)
    writeFile(CHECKSTYLE, "not approved\n")

    const { exitCode, stdout } = await cli(["check", "--when", "task-end", "--changed", "--asked", "--agent-context"], context)

    expect(exitCode).toBe(1)
    expect(stdout.startsWith("✗ protected files · changed without the user's approval")).toBe(true)
    expect(stdout).toContain(`  ${CHECKSTYLE} (changed)`)
    expect(stdout).not.toContain(ARCH_TEST)
  })

  it("renews the main session's fingerprint for an approved edit a subagent made in its own session", async () => {
    project()
    await cli(["check", "--when", "session-start", "--agent-context"], context)
    writeFile(CHECKSTYLE, "approved in a subagent\n")
    const subagent = JSON.stringify({ agent: "opencode", session: "oc-sub", subagent: true })
    await cli(["check", "--when", "edit", "--asked", "--root-session", "oc-1", "--file", CHECKSTYLE, "--agent-context"], subagent)

    const { exitCode } = await cli(["check", "--when", "task-end", "--changed", "--asked", "--agent-context"], context)

    expect(exitCode).toBe(0)
  })

  it("checks no protected file by hand, without an agent's session", async () => {
    project()
    writeFile(ARCH_TEST, "changed\n")

    expect((await cli(["check"])).exitCode).toBe(0)
    expect(await cli(["check", "--when", "edit", "--file", "interlint.yaml"])).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    expect(await cli(["check", "--when", "edit", "--file", ARCH_TEST])).toEqual({ exitCode: 0, stdout: "", stderr: "" })
  })
})
