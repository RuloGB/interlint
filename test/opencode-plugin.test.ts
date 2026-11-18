import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import plugin, {
  type CheckRun,
  changedFiles,
  type PermissionEvaluation,
  linesWritten,
  createInterlintPlugin,
  DEFAULT_EDIT_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  editNote,
  MAX_CONSECUTIVE_BLOCKS,
  MAX_OUTPUT_CHARS,
  pauseMark,
  type RunChecks,
  runInterlint,
  TaskEndGate,
} from "../integrations/opencode/interlint/index.js"
import {
  NOT_PAUSED_MESSAGE,
  PAUSE_ADVICE,
  PAUSED_MESSAGE,
  PAUSED_REMINDER,
  pauseMarkOf,
  RESUMED_MESSAGE,
} from "../src/domain/session-pause.js"

const VIOLATIONS: CheckRun = { exitCode: 1, output: "✗ architecture · ARCH-01: rule\n\nFix these problems before continuing.\n" }
const PASSED: CheckRun = { exitCode: 0, output: "" }
const PASS_LINE = "✓ Interlint · checks passed: checkstyle (1.2s), architecture (4.3s)"
/** Checks that ran and passed: the CLI names them. */
const PASSED_NAMED: CheckRun = { exitCode: 0, output: `${PASS_LINE}\n` }

describe("TaskEndGate", () => {
  it("lets the task end when the checks pass", () => {
    expect(new TaskEndGate().decide("s1", PASSED)).toEqual({ action: "none" })
  })

  it("makes the agent continue with the failures, counting the attempts", () => {
    const gate = new TaskEndGate()

    expect(gate.decide("s1", VIOLATIONS)).toEqual({
      action: "continue",
      text: `Interlint: the task cannot end yet (attempt 1 of ${MAX_CONSECUTIVE_BLOCKS}).\n\nFix these failures before you answer: they are in the projects this task changed, so fixing them is part of the task, even if you were asked to change nothing else. Asking the user whether to fix them does not end the task.\n\n${VIOLATIONS.output}`,
    })
    expect(gate.decide("s1", VIOLATIONS)).toMatchObject({ action: "continue", text: expect.stringContaining("attempt 2 of 3") })
  })

  it("leaves the failure of the protected files as it is: it says what to do itself", () => {
    const output = "✗ protected files · changed without the user's approval\n\n  interlint.yaml (changed)\n"

    expect(new TaskEndGate().decide("s1", { exitCode: 1, output })).toEqual({
      action: "continue",
      text: `Interlint: the task cannot end yet (attempt 1 of ${MAX_CONSECUTIVE_BLOCKS}).\n\n${output}`,
    })
  })

  it("keeps the instructions of the protected files apart when a check fails too", () => {
    const output = `✗ protected files · changed without the user's approval\n\n  interlint.yaml (changed)\n\n${VIOLATIONS.output}`

    expect(new TaskEndGate().decide("s1", { exitCode: 1, output })).toEqual({
      action: "continue",
      text: `Interlint: the task cannot end yet (attempt 1 of ${MAX_CONSECUTIVE_BLOCKS}).\n\nFix these failures before you answer: they are in the projects this task changed, so fixing them is part of the task, even if you were asked to change nothing else. Asking the user whether to fix them does not end the task. The protected files are a separate case: follow the instructions in their own message.\n\n${output}`,
    })
  })

  it("stops blocking after the limit and only reports, advising the user how to pause Interlint", () => {
    const gate = new TaskEndGate()
    for (let attempt = 0; attempt < MAX_CONSECUTIVE_BLOCKS; attempt++) {
      expect(gate.decide("s1", VIOLATIONS)).not.toMatchObject({ text: expect.stringContaining("interlint: pause") })
    }

    expect(gate.decide("s1", VIOLATIONS)).toEqual({
      action: "report",
      text: `Interlint: the checks still fail after ${MAX_CONSECUTIVE_BLOCKS} attempts, so the task may end.\n\n${VIOLATIONS.output.trimEnd()}\n\n${PAUSE_ADVICE}\n`,
    })
    expect(gate.decide("s1", VIOLATIONS)).toMatchObject({ action: "continue", text: expect.stringContaining("attempt 1 of 3") })
  })

  it("lets the task end and reports, without resuming the agent, a notice for the user", () => {
    const notice = "ℹ Interlint · for the user: the ArchUnit store archunit_store was frozen from broken compiled classes\n"
    const gate = new TaskEndGate()
    gate.decide("s1", VIOLATIONS)

    expect(gate.decide("s1", { exitCode: 0, output: notice })).toEqual({ action: "report", text: notice })
    expect(gate.decide("s1", VIOLATIONS)).toMatchObject({ text: expect.stringContaining("attempt 1 of 3") })
  })

  it("reports, without resuming the agent, the checks that passed", () => {
    expect(new TaskEndGate().decide("s1", PASSED_NAMED)).toEqual({ action: "report", text: PASS_LINE })
    expect(new TaskEndGate().decide("s1", { exitCode: 0, output: `Picked up JAVA_TOOL_OPTIONS\n${PASS_LINE}\n` })).toEqual({
      action: "report",
      text: PASS_LINE,
    })
  })

  it("reports a notice for the user whole, with the checks that passed after it", () => {
    const output = `ℹ Interlint · for the user: the ArchUnit store archunit_store was frozen from broken compiled classes\n${PASS_LINE}\n`

    expect(new TaskEndGate().decide("s1", { exitCode: 0, output })).toEqual({ action: "report", text: output })
  })

  it("ignores other output when the checks pass", () => {
    expect(new TaskEndGate().decide("s1", { exitCode: 0, output: "Picked up JAVA_TOOL_OPTIONS\n" })).toEqual({ action: "none" })
  })

  it("starts counting again after the checks pass", () => {
    const gate = new TaskEndGate()
    gate.decide("s1", VIOLATIONS)
    gate.decide("s1", VIOLATIONS)
    gate.decide("s1", PASSED)

    expect(gate.decide("s1", VIOLATIONS)).toMatchObject({ text: expect.stringContaining("attempt 1 of 3") })
  })

  it("counts each session on its own", () => {
    const gate = new TaskEndGate()
    gate.decide("s1", VIOLATIONS)

    expect(gate.decide("s2", VIOLATIONS)).toMatchObject({ text: expect.stringContaining("attempt 1 of 3") })
  })

  it("reports an exit 1 that is not an Interlint report, such as cmd.exe not finding the CLI", () => {
    const notFound = { exitCode: 1, output: "'interlint' is not recognized as an internal or external command\n" }

    expect(new TaskEndGate().decide("s1", notFound)).toEqual({
      action: "report",
      text: `Interlint could not run the checks (exit code 1).\n\n${notFound.output}`,
    })
  })

  it("reports a configuration error without making the agent continue", () => {
    expect(new TaskEndGate().decide("s1", { exitCode: 2, output: "interlint: interlint.yaml not found in /repo\n" })).toEqual({
      action: "report",
      text: "Interlint could not run the checks (exit code 2).\n\ninterlint: interlint.yaml not found in /repo\n",
    })
  })
})

describe("runInterlint", () => {
  let scratch: string

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "interlint-plugin-"))
  })

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  function script(name: string, body: string) {
    writeFileSync(join(scratch, name), body)
    return `node ${name}`
  }

  it("gives up after the timeout, so a hung build never disables the gate", async () => {
    const command = script("hang.mjs", "setTimeout(() => {}, 60_000)\n")

    const run = await runInterlint(scratch, command, 300)

    expect(run).toEqual({ exitCode: 2, output: "The checks did not finish within 0.3 s.\n" })
  })

  it("caps the output it sends to the session", async () => {
    // exitCode, not exit(): on macOS writes to a pipe are asynchronous, so exit() would drop most of the output.
    const command = script("noisy.mjs", "process.stdout.write('✗ ' + 'x'.repeat(200_000))\nprocess.exitCode = 1\n")

    const run = await runInterlint(scratch, command, 10_000)

    expect(run.exitCode).toBe(1)
    expect(run.output.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS + 100)
    expect(run.output.startsWith("✗ xxx")).toBe(true)
    expect(run.output.endsWith("… output truncated by Interlint.\n")).toBe(true)
  })
})

type PluginEvent = { type: string; data?: { sessionID?: string } }

/**
 * A fake OpenCode V2 plugin context that records what the plugin sends to the session.
 * `events` are delivered when the plugin subscribes; `emit` delivers more later, the way turns go on.
 * `sessions` maps a session ID to its parent, for the sessions a subagent runs in, to how many lookups fail first,
 * and to the directory it runs in, `/repo` by default; `null` returns no location, as an older OpenCode might.
 * The lookups of a `held` session wait until `release` answers them, the oldest first.
 * Sending a message to a session in `failingSynthetic` throws.
 */
function fakeContext(
  events: PluginEvent[] = [],
  sessions: Record<
    string,
    {
      parentID?: string
      failedLookups?: number
      directory?: string | null
      held?: boolean
      agent?: string
      model?: { id: string; providerID: string; variant?: string }
    }
  > = {},
  failingSynthetic: string[] = [],
) {
  const sent: { sessionID: string; text: string; resume?: boolean }[] = []
  /** The `description` of each message sent: what OpenCode Desktop shows in the chat. */
  const labels: (string | undefined)[] = []
  const heldLookups: (() => void)[] = []
  const release = () => heldLookups.shift()?.()
  const hooks = new Map<string, (event: ToolEvent) => Promise<void> | void>()
  const queue = [...events]
  let wake: (() => void) | undefined
  let finished!: () => void
  /** Resolves once the plugin got every event delivered so far. */
  const done = new Promise<void>((resolve) => (finished = resolve))
  const ctx = {
    location: { directory: "/repo" },
    options: {} as Record<string, unknown>,
    session: {
      get: async (input: { sessionID: string }) => {
        const session = sessions[input.sessionID]
        if (input.sessionID === "missing") throw new Error("Session not found")
        if (session?.held) await new Promise<void>((resolve) => heldLookups.push(resolve))
        if (session?.failedLookups) {
          session.failedLookups--
          throw new Error("Session lookup failed")
        }
        const directory = session?.directory === undefined ? "/repo" : session.directory
        return {
          id: input.sessionID,
          parentID: session?.parentID,
          agent: session?.agent,
          model: session?.model,
          ...(directory === null ? {} : { location: { directory } }),
        }
      },
      synthetic: async (input: { sessionID: string; text: string; description?: string; resume?: boolean }) => {
        if (failingSynthetic.includes(input.sessionID)) throw new Error("synthetic failed")
        sent.push({ sessionID: input.sessionID, text: input.text, resume: input.resume })
        labels.push(input.description)
      },
    },
    event: {
      subscribe: async function* () {
        for (;;) {
          while (queue.length > 0) yield queue.shift()!
          finished()
          await new Promise<void>((resolve) => (wake = resolve))
        }
      },
    },
    tool: {
      hook: async (name: string, callback: (event: ToolEvent) => Promise<void> | void) => {
        hooks.set(name, callback)
        return { dispose: async () => void hooks.delete(name) }
      },
    },
  }
  const emit = (type: string, sessionID: string) => {
    queue.push({ type, data: { sessionID } })
    wake?.()
  }
  /** Calls the plugin's `execute.after` hook the way OpenCode does after a tool call, and returns the event. */
  const afterTool = async (
    tool: string,
    input: unknown,
    status: "completed" | "error" = "completed",
    { sessionID = "s1", result = { content: [{ type: "text", text: "Edited the file" }] } }: Partial<ToolCall> = {},
  ) => {
    const event: ToolEvent =
      status === "completed" ? { tool, sessionID, input, status, result } : { tool, sessionID, input, status, error: new Error("failed") }
    await hooks.get("execute.after")?.(event)
    return event
  }
  return { ctx, sent, labels, done, emit, afterTool, release }
}

interface ToolCall {
  sessionID: string
  result: { content?: string | { type: string; text?: string }[]; metadata?: Record<string, unknown> }
}

/** A tool call as `execute.after` gets it: `result` when it completed, `error` when it failed. */
interface ToolEvent {
  tool: string
  sessionID: string
  input: unknown
  status: "completed" | "error"
  result?: ToolCall["result"]
  error?: unknown
}

/** Lets the plugin finish everything it can do without a new event. */
const settled = () => new Promise((resolve) => setImmediate(resolve))

const SUCCEEDED = "session.execution.succeeded"
const ANSWER = '<subagent sessionID="writer" state="completed">\nDone\n</subagent>'
/** What the `subagent` tool returns to the main agent when a foreground subagent finished. */
const subagentAnswer = { content: ANSWER, metadata: { sessionID: "writer", status: "completed" } }

/** Fake checks: edit checks pass, task-end ones give `taskEnd` in turn, then pass. Records the task-end arguments. */
function checksGiving(...taskEnd: CheckRun[]) {
  const runs: string[][] = []
  const run = async (_directory: string, _command: string, _timeoutMs: number, args: string[] = []) => {
    if (args[2] === "edit") return PASSED
    runs.push(args)
    return taskEnd.shift() ?? PASSED
  }
  return { runs, run }
}

const TASK_END = ["check", "--when", "task-end", "--changed"]
const WRITER_FILE = "orders/src/main/java/shop/Order.java"
const WRITER_RUN = [...TASK_END, "--file", WRITER_FILE]
const SESSIONS = { writer: { parentID: "main" }, reviewer: { parentID: "main" } }

/** Makes the plugin see the subagent `writer` resume after a synthetic message and end its turn again. */
async function writerTurn(emit: (type: string, sessionID: string) => void) {
  emit("session.execution.started", "writer")
  emit(SUCCEEDED, "writer")
  await settled()
}

describe("OpenCode plugin", () => {
  it("has a stable id", () => {
    expect(plugin.id).toBe("interlint")
  })

  it("runs the task-end checks of the projects that changed, in the project directory, when an agent turn ends", async () => {
    const runs: { directory: string; args?: string[] }[] = []
    const { ctx, done } = fakeContext([{ type: SUCCEEDED, data: { sessionID: "s1" } }])

    await createInterlintPlugin(async (directory, _command, _timeoutMs, args) => {
      runs.push({ directory, args })
      return PASSED
    }).setup(ctx)
    await done
    await settled()

    expect(runs).toEqual([{ directory: "/repo", args: TASK_END }])
  })

  it("ignores the turn end of a session of another project open in the same OpenCode", async () => {
    const { runs, run } = checksGiving(VIOLATIONS)
    const { ctx, sent, done } = fakeContext([{ type: SUCCEEDED, data: { sessionID: "other" } }], {
      other: { directory: "/other-repo" },
    })

    await createInterlintPlugin(run).setup(ctx)
    await done
    await settled()

    expect(runs).toEqual([])
    expect(sent).toEqual([])
  })

  it("ignores the edits of a session of another project open in the same OpenCode", async () => {
    const runs: string[][] = []
    const { ctx, done, afterTool } = fakeContext([], { other: { directory: "/other-repo" } })
    await createInterlintPlugin(async (_directory, _command, _timeoutMs, args = []) => {
      runs.push(args)
      return VIOLATIONS
    }).setup(ctx)
    await done

    const event = await afterTool("edit", { path: "src/Other.java" }, "completed", { sessionID: "other" })

    expect(runs).toEqual([])
    expect(event.result).toEqual({ content: [{ type: "text", text: "Edited the file" }] })
  })

  it("runs the task-end checks of a session opened in a directory inside the project", async () => {
    const { runs, run } = checksGiving()
    const { ctx, done } = fakeContext([{ type: SUCCEEDED, data: { sessionID: "s1" } }], {
      s1: { directory: "/repo/orders" },
    })

    await createInterlintPlugin(run).setup(ctx)
    await done
    await settled()

    expect(runs).toEqual([TASK_END])
  })

  it("ignores a session of a sibling project whose name starts like this one's", async () => {
    const { runs, run } = checksGiving()
    const { ctx, done } = fakeContext([{ type: SUCCEEDED, data: { sessionID: "s1" } }], { s1: { directory: "/repo-api" } })

    await createInterlintPlugin(run).setup(ctx)
    await done
    await settled()

    expect(runs).toEqual([])
  })

  it("runs the task-end checks of a session whose directory names the project through a symbolic link", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "interlint-plugin-"))
    try {
      const project = join(scratch, "project")
      const link = join(scratch, "link")
      mkdirSync(project)
      // A junction on Windows, which needs no administrator rights.
      symlinkSync(project, link, "junction")
      const { runs, run } = checksGiving()
      const { ctx, done } = fakeContext([{ type: SUCCEEDED, data: { sessionID: "s1" } }], { s1: { directory: link } })
      ctx.location.directory = project

      await createInterlintPlugin(run).setup(ctx)
      await done
      await settled()

      expect(runs).toEqual([TASK_END])
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it("runs the task-end checks of a session whose directory OpenCode does not give", async () => {
    const { runs, run } = checksGiving()
    const { ctx, done } = fakeContext([{ type: SUCCEEDED, data: { sessionID: "s1" } }], { s1: { directory: null } })

    await createInterlintPlugin(run).setup(ctx)
    await done
    await settled()

    expect(runs).toEqual([TASK_END])
  })

  it("tells the session which checks passed at task end, without resuming it", async () => {
    const { ctx, sent, done } = fakeContext([{ type: SUCCEEDED, data: { sessionID: "s1" } }])

    await createInterlintPlugin(async () => PASSED_NAMED).setup(ctx)
    await done
    await settled()

    expect(sent).toEqual([{ sessionID: "s1", text: PASS_LINE, resume: false }])
  })

  it("resumes the session with the failures", async () => {
    const { ctx, sent, done } = fakeContext([{ type: SUCCEEDED, data: { sessionID: "s1" } }])

    await createInterlintPlugin(async () => VIOLATIONS).setup(ctx)
    await done
    await settled()

    expect(sent).toEqual([{ sessionID: "s1", text: expect.stringContaining("ARCH-01: rule"), resume: true }])
  })

  it("labels each message with its first line, since OpenCode Desktop shows only the label in the chat", async () => {
    const passing = fakeContext([{ type: SUCCEEDED, data: { sessionID: "s1" } }])
    await createInterlintPlugin(async () => PASSED_NAMED).setup(passing.ctx)
    await passing.done
    await settled()
    const failing = fakeContext([{ type: SUCCEEDED, data: { sessionID: "s1" } }])
    await createInterlintPlugin(async () => VIOLATIONS).setup(failing.ctx)
    await failing.done
    await settled()

    expect(passing.labels).toEqual([PASS_LINE])
    expect(failing.labels).toEqual([`Interlint: the task cannot end yet (attempt 1 of ${MAX_CONSECUTIVE_BLOCKS}).`])
  })

  it("still runs the task-end checks when it cannot tell whether the session is a subagent", async () => {
    const { ctx, sent, done } = fakeContext([{ type: SUCCEEDED, data: { sessionID: "missing" } }])

    await createInterlintPlugin(async () => VIOLATIONS).setup(ctx)
    await done
    await settled()

    expect(sent).toEqual([{ sessionID: "missing", text: expect.stringContaining("ARCH-01: rule"), resume: true }])
  })

  it("ignores other events", async () => {
    const runs: string[] = []
    const { ctx, done } = fakeContext([{ type: "session.created", data: { sessionID: "s1" } }])

    await createInterlintPlugin(async (directory) => {
      runs.push(directory)
      return PASSED
    }).setup(ctx)
    await done

    expect(runs).toEqual([])
  })
})

describe("OpenCode plugin with subagents", () => {
  it("does not run the task-end checks when a subagent that changed no file ends its turn", async () => {
    const { runs, run } = checksGiving(VIOLATIONS)
    const { ctx, sent, done, emit } = fakeContext([], SESSIONS)
    await createInterlintPlugin(run).setup(ctx)
    await done

    emit(SUCCEEDED, "reviewer")
    await settled()

    expect(runs).toEqual([])
    expect(sent).toEqual([])
  })

  it("runs the checks of the projects a subagent changed when its turn ends, and resumes it with the failures", async () => {
    const { runs, run } = checksGiving(VIOLATIONS)
    const { ctx, sent, done, emit, afterTool } = fakeContext([], SESSIONS)
    await createInterlintPlugin(run).setup(ctx)
    await done

    await afterTool("edit", { path: WRITER_FILE }, "completed", { sessionID: "writer" })
    emit(SUCCEEDED, "writer")
    await settled()

    expect(runs).toEqual([WRITER_RUN])
    expect(sent).toEqual([
      {
        sessionID: "writer",
        text: `Interlint: the task cannot end yet (attempt 1 of ${MAX_CONSECUTIVE_BLOCKS}).\n\nFix these failures yourself before you answer: asking how to proceed does not end the task. After ${MAX_CONSECUTIVE_BLOCKS} attempts they go to the agent that delegated this work.\n\n${VIOLATIONS.output}`,
        resume: true,
      },
    ])
  })

  it("holds a foreground subagent's answer until its checks pass, and tells the main agent it fixed them", async () => {
    const { runs, run } = checksGiving(VIOLATIONS)
    const { ctx, sent, done, emit, afterTool } = fakeContext([], SESSIONS)
    await createInterlintPlugin(run).setup(ctx)
    await done
    await afterTool("edit", { path: WRITER_FILE }, "completed", { sessionID: "writer" })
    emit(SUCCEEDED, "writer")

    let answered = false
    const answer = afterTool("subagent", {}, "completed", { sessionID: "main", result: subagentAnswer })
    void answer.then(() => (answered = true))
    await settled()
    expect(answered).toBe(false)

    await writerTurn(emit)

    expect((await answer).result).toEqual({
      ...subagentAnswer,
      content: `${ANSWER}\n\nInterlint: the checks failed after this answer, so the subagent went on to fix them. They pass now.`,
    })
    expect(runs).toEqual([WRITER_RUN, WRITER_RUN])
    expect(sent.map((message) => message.sessionID)).toEqual(["writer"])
  })

  it("checks a foreground subagent once even when its answer comes before its turn-end event", async () => {
    const { runs, run } = checksGiving(VIOLATIONS)
    const { ctx, done, emit, afterTool } = fakeContext([], SESSIONS)
    await createInterlintPlugin(run).setup(ctx)
    await done
    await afterTool("edit", { path: WRITER_FILE }, "completed", { sessionID: "writer" })

    const answer = afterTool("subagent", {}, "completed", { sessionID: "main", result: subagentAnswer })
    await settled()
    emit(SUCCEEDED, "writer")
    await settled()
    await writerTurn(emit)

    expect((await answer).result?.content).toContain("They pass now.")
    expect(runs).toEqual([WRITER_RUN, WRITER_RUN])
  })

  it("leaves a foreground subagent's answer as it is when its checks pass", async () => {
    const { run } = checksGiving()
    const { ctx, done, emit, afterTool } = fakeContext([], SESSIONS)
    await createInterlintPlugin(run).setup(ctx)
    await done
    await afterTool("edit", { path: WRITER_FILE }, "completed", { sessionID: "writer" })
    emit(SUCCEEDED, "writer")

    const answer = await afterTool("subagent", {}, "completed", { sessionID: "main", result: subagentAnswer })

    expect(answer.result).toEqual(subagentAnswer)
  })

  it("hands the failures to the main agent in the answer when the subagent cannot fix them", async () => {
    const { runs, run } = checksGiving(VIOLATIONS, VIOLATIONS, VIOLATIONS, VIOLATIONS)
    const { ctx, sent, done, emit, afterTool } = fakeContext([], SESSIONS)
    await createInterlintPlugin(run).setup(ctx)
    await done
    await afterTool("edit", { path: WRITER_FILE }, "completed", { sessionID: "writer" })
    emit(SUCCEEDED, "writer")

    const answer = afterTool("subagent", {}, "completed", { sessionID: "main", result: subagentAnswer })
    await settled()
    for (let attempt = 0; attempt < MAX_CONSECUTIVE_BLOCKS; attempt++) await writerTurn(emit)

    expect((await answer).result?.content).toBe(
      `${ANSWER}\n\nInterlint: the subagent could not make the checks pass after ${MAX_CONSECUTIVE_BLOCKS} attempts, so they are yours to fix.\n\n${VIOLATIONS.output}`,
    )
    expect(runs).toHaveLength(MAX_CONSECUTIVE_BLOCKS + 1)
    expect(sent.map((message) => message.sessionID)).toEqual(["writer", "writer", "writer", "writer"])
    expect(sent.at(-1)).toEqual({
      sessionID: "writer",
      text: `✗ Interlint · checks still fail after ${MAX_CONSECUTIVE_BLOCKS} attempts: architecture. They go to the agent that delegated this work.`,
      resume: false,
    })
  })

  it("sends a background subagent's failures to its parent when the subagent cannot fix them", async () => {
    const { run } = checksGiving(VIOLATIONS, VIOLATIONS, VIOLATIONS, VIOLATIONS)
    const { ctx, sent, done, emit, afterTool } = fakeContext([], SESSIONS)
    await createInterlintPlugin(run).setup(ctx)
    await done
    await afterTool("edit", { path: WRITER_FILE }, "completed", { sessionID: "writer" })
    emit(SUCCEEDED, "writer")
    await settled()

    for (let attempt = 0; attempt < MAX_CONSECUTIVE_BLOCKS; attempt++) await writerTurn(emit)

    expect(sent.at(-1)).toEqual({
      sessionID: "main",
      text: `Interlint: subagent session writer could not make the checks pass after ${MAX_CONSECUTIVE_BLOCKS} attempts, so they are yours to fix.\n\n${VIOLATIONS.output}`,
      resume: true,
    })
  })

  it("tells the parent without resuming it when a subagent's checks cannot run", async () => {
    const broken = { exitCode: 2, output: "interlint: interlint.yaml not found in /repo\n" }
    const { run } = checksGiving(broken)
    const { ctx, sent, done, emit, afterTool } = fakeContext([], SESSIONS)
    await createInterlintPlugin(run).setup(ctx)
    await done
    await afterTool("edit", { path: WRITER_FILE }, "completed", { sessionID: "writer" })

    emit(SUCCEEDED, "writer")
    await settled()

    expect(sent).toEqual([
      { sessionID: "writer", text: "Interlint could not run the checks (exit code 2).", resume: false },
      {
        sessionID: "main",
        text: `Interlint could not run the checks of subagent session writer (exit code 2).\n\n${broken.output}`,
        resume: false,
      },
    ])
  })

  it("waits for a subagent that has unchecked changes before running the main agent's checks", async () => {
    const { runs, run } = checksGiving()
    const { ctx, done, emit, afterTool } = fakeContext([], SESSIONS)
    await createInterlintPlugin(run).setup(ctx)
    await done
    await afterTool("edit", { path: WRITER_FILE }, "completed", { sessionID: "writer" })

    emit(SUCCEEDED, "main")
    await settled()
    expect(runs).toEqual([])

    emit(SUCCEEDED, "writer")
    await settled()
    expect(runs).toEqual([WRITER_RUN, TASK_END])
  })

  it("runs the main agent's checks when a subagent with unchecked changes is interrupted", async () => {
    const { runs, run } = checksGiving()
    const { ctx, done, emit, afterTool } = fakeContext([], SESSIONS)
    await createInterlintPlugin(run).setup(ctx)
    await done
    await afterTool("edit", { path: WRITER_FILE }, "completed", { sessionID: "writer" })
    emit(SUCCEEDED, "main")

    emit("session.execution.interrupted", "writer")
    await settled()

    expect(runs).toEqual([TASK_END])
  })

  it("does not keep the main agent waiting for a subagent whose turn end it once took for the main agent's", async () => {
    const broken = { exitCode: 2, output: "interlint: interlint.yaml not found in /repo\n" }
    const { runs, run } = checksGiving(broken)
    // Its edit and its turn end both look the session up: both fail.
    const { ctx, done, emit, afterTool } = fakeContext([], { writer: { parentID: "main", failedLookups: 2 } })
    await createInterlintPlugin(run).setup(ctx)
    await done
    await afterTool("edit", { path: WRITER_FILE }, "completed", { sessionID: "writer" })
    emit(SUCCEEDED, "writer")
    await settled()

    emit(SUCCEEDED, "main")
    await settled()

    expect(runs).toEqual([TASK_END, TASK_END])
  })

  it("still runs the main agent's checks when the message about a subagent's failures cannot be sent", async () => {
    const { runs, run } = checksGiving(VIOLATIONS, VIOLATIONS, VIOLATIONS, VIOLATIONS)
    const { ctx, done, emit, afterTool } = fakeContext([], SESSIONS, ["main"])
    await createInterlintPlugin(run).setup(ctx)
    await done
    await afterTool("edit", { path: WRITER_FILE }, "completed", { sessionID: "writer" })
    emit(SUCCEEDED, "main")
    emit(SUCCEEDED, "writer")
    await settled()

    for (let attempt = 0; attempt < MAX_CONSECUTIVE_BLOCKS; attempt++) await writerTurn(emit)

    expect(runs.at(-1)).toEqual(TASK_END)
  })

  describe("with a time limit", () => {
    const LIMIT = 1_000
    // Only setTimeout is faked: the tests still let the plugin run with setImmediate.
    beforeEach(() => void vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }))
    afterEach(() => void vi.useRealTimers())

    /** Lets the plugin act on what came before, moves the fake clock on, and lets it act on the timers that fired. */
    async function waitFor(ms: number) {
      await settled()
      vi.advanceTimersByTime(ms)
      await settled()
    }

    async function setUp(run: RunChecks) {
      const context = fakeContext([], SESSIONS)
      context.ctx.options = { subagentTimeoutMs: LIMIT }
      await createInterlintPlugin(run).setup(context.ctx)
      await context.done
      await context.afterTool("edit", { path: WRITER_FILE }, "completed", { sessionID: "writer" })
      return context
    }

    const STOPPED = `${ANSWER}\n\nInterlint: the subagent stopped before the checks passed, so they are yours to fix.\n\n${VIOLATIONS.output}`

    it("stops waiting for a resumed subagent whose turn never ends, and hands its failures to the main agent", async () => {
      const { emit, afterTool } = await setUp(checksGiving(VIOLATIONS).run)
      emit(SUCCEEDED, "writer")
      const answer = afterTool("subagent", {}, "completed", { sessionID: "main", result: subagentAnswer })
      await waitFor(LIMIT - 1)
      let answered = false
      void answer.then(() => (answered = true))
      await settled()
      expect(answered).toBe(false)

      await waitFor(1)

      expect((await answer).result?.content).toBe(STOPPED)
    })

    it("stops waiting for a resumed subagent whose session is deleted", async () => {
      const { emit, afterTool } = await setUp(checksGiving(VIOLATIONS).run)
      emit(SUCCEEDED, "writer")
      const answer = afterTool("subagent", {}, "completed", { sessionID: "main", result: subagentAnswer })
      await settled()

      emit("session.deleted", "writer")

      expect((await answer).result?.content).toBe(STOPPED)
    })

    it("runs the main agent's checks after waiting too long for a subagent that never ends its turn", async () => {
      const { runs, run } = checksGiving()
      const { emit } = await setUp(run)
      emit(SUCCEEDED, "main")
      await waitFor(LIMIT - 1)
      expect(runs).toEqual([])

      await waitFor(1)

      expect(runs).toEqual([TASK_END])
    })

    it("gives every wait of the main agent the whole time limit, however an earlier wait ended", async () => {
      const { runs, run } = checksGiving()
      const { emit, afterTool } = await setUp(run)
      emit(SUCCEEDED, "main")
      await waitFor(LIMIT / 2)
      emit(SUCCEEDED, "writer")
      await settled()
      expect(runs).toEqual([WRITER_RUN, TASK_END])

      await afterTool("edit", { path: WRITER_FILE }, "completed", { sessionID: "writer" })
      emit(SUCCEEDED, "main")
      await waitFor(LIMIT - 1)
      expect(runs).toEqual([WRITER_RUN, TASK_END])

      await waitFor(1)
      expect(runs).toEqual([WRITER_RUN, TASK_END, TASK_END])
    })
  })

  it("runs the main agent's checks once when a flush looks at its turn end while the turn end looks too", async () => {
    const { runs, run } = checksGiving()
    // `other` is a subagent of another main session, whose lookup both waits for.
    const { ctx, done, emit, afterTool, release } = fakeContext([], {
      other: { parentID: "otherMain" },
      otherMain: { held: true },
    })
    await createInterlintPlugin(run).setup(ctx)
    await done
    await afterTool("edit", { path: WRITER_FILE }, "completed", { sessionID: "other" })
    emit(SUCCEEDED, "main")
    await settled()
    // A deleted session flushes the waiting main sessions, while the main turn end still looks at `other`.
    emit("session.deleted", "gone")
    await settled()

    release()
    await settled()
    release()
    await settled()

    expect(runs).toEqual([TASK_END])
  })

  it("runs the main agent's checks at once when a subagent with unchecked changes is deleted", async () => {
    const { runs, run } = checksGiving()
    const { ctx, done, emit, afterTool } = fakeContext([], SESSIONS)
    await createInterlintPlugin(run).setup(ctx)
    await done
    await afterTool("edit", { path: WRITER_FILE }, "completed", { sessionID: "writer" })
    emit(SUCCEEDED, "main")

    emit("session.deleted", "writer")
    await settled()

    expect(runs).toEqual([TASK_END])
  })

  it("leaves the answer of a background subagent alone", async () => {
    const { runs, run } = checksGiving()
    const { ctx, done, afterTool } = fakeContext([], SESSIONS)
    await createInterlintPlugin(run).setup(ctx)
    await done
    await afterTool("edit", { path: WRITER_FILE }, "completed", { sessionID: "writer" })
    const started = { content: "started", metadata: { sessionID: "writer", status: "running" } }

    const answer = await afterTool("subagent", {}, "completed", { sessionID: "main", result: started })

    expect(answer.result).toEqual(started)
    expect(runs).toEqual([])
  })
})

/**
 * The fake context with OpenCode's `experimental.idle` session hook. `idle` fires it for a session the way OpenCode does
 * just before that session would go idle, and resolves when the plugin's hook returns, as OpenCode waits for it.
 */
function withIdleHook(fake: ReturnType<typeof fakeContext>) {
  let onIdle: ((event: { sessionID: string; background: unknown[] }) => Promise<void> | void) | undefined
  Object.assign(fake.ctx.session, {
    hook: async (name: string, callback: typeof onIdle) => {
      if (name === "experimental.idle") onIdle = callback
      return { dispose: async () => {} }
    },
  })
  const idle = async (sessionID: string) => {
    await onIdle?.({ sessionID, background: [] })
  }
  return { ...fake, idle }
}

/** Fake checks whose task-end runs wait until `finish` gives their result, the oldest first. Edit checks pass. */
function heldChecks() {
  const runs: string[][] = []
  const waiting: ((run: CheckRun) => void)[] = []
  const run: RunChecks = async (_directory, _command, _timeoutMs, args = []) => {
    if (args[2] === "edit") return PASSED
    runs.push(args)
    return new Promise<CheckRun>((resolve) => waiting.push(resolve))
  }
  const finish = (result: CheckRun) => waiting.shift()?.(result)
  return { runs, run, finish }
}

const BACKGROUND_STARTED = { content: "started", metadata: { sessionID: "writer", status: "running" } }
const WRITER_BLOCK = `Interlint: the task cannot end yet (attempt 1 of ${MAX_CONSECUTIVE_BLOCKS}).\n\nFix these failures yourself before you answer: asking how to proceed does not end the task. After ${MAX_CONSECUTIVE_BLOCKS} attempts they go to the agent that delegated this work.\n\n${VIOLATIONS.output}`

describe("OpenCode plugin holding a subagent until its checks pass", () => {
  it("runs a subagent's checks before it goes idle, and gives it the failures to fix in the same execution", async () => {
    const { runs, run } = checksGiving(VIOLATIONS)
    const { ctx, sent, done, idle, afterTool } = withIdleHook(fakeContext([], SESSIONS))
    await createInterlintPlugin(run).setup(ctx)
    await done
    await afterTool("edit", { path: WRITER_FILE }, "completed", { sessionID: "writer" })

    await idle("writer")

    expect(runs).toEqual([WRITER_RUN])
    expect(sent).toEqual([{ sessionID: "writer", text: WRITER_BLOCK, resume: true }])

    await idle("writer")

    expect(runs).toEqual([WRITER_RUN, WRITER_RUN])
    expect(sent).toHaveLength(1)
  })

  it("keeps the subagent from going idle while its checks run, and tells the user only after its turn ends", async () => {
    const { runs, run, finish } = heldChecks()
    const { ctx, sent, done, emit, idle, afterTool } = withIdleHook(fakeContext([], SESSIONS))
    ctx.options.runningNoticeMs = 0
    await createInterlintPlugin(run).setup(ctx)
    await done
    await afterTool("edit", { path: WRITER_FILE }, "completed", { sessionID: "writer" })

    let idled = false
    const going = idle("writer").then(() => (idled = true))
    await settled()
    expect(idled).toBe(false)

    finish(PASSED_NAMED)
    await going
    // A message admitted before the subagent goes idle would make it answer again.
    expect(sent).toEqual([])

    emit(SUCCEEDED, "writer")
    await settled()

    expect(sent).toEqual([{ sessionID: "writer", text: PASS_LINE, resume: false }])
    expect(runs).toEqual([WRITER_RUN])
  })

  it("tells the main agent in a foreground subagent's answer that it fixed its checks, without holding the answer", async () => {
    const { runs, run } = checksGiving(VIOLATIONS)
    const { ctx, done, emit, idle, afterTool } = withIdleHook(fakeContext([], SESSIONS))
    await createInterlintPlugin(run).setup(ctx)
    await done
    await afterTool("edit", { path: WRITER_FILE }, "completed", { sessionID: "writer" })
    await idle("writer")
    await idle("writer")
    emit(SUCCEEDED, "writer")
    await settled()

    const answer = await afterTool("subagent", {}, "completed", { sessionID: "main", result: subagentAnswer })

    expect(answer.result?.content).toBe(
      `${ANSWER}\n\nInterlint: the checks failed when the subagent first finished, so it fixed them before this answer. They pass now.`,
    )
    expect(runs).toEqual([WRITER_RUN, WRITER_RUN])
  })

  it("sends a background subagent's failures to its parent when it cannot fix them, then lets it go idle", async () => {
    const { runs, run } = checksGiving(VIOLATIONS, VIOLATIONS, VIOLATIONS, VIOLATIONS)
    const { ctx, sent, done, emit, idle, afterTool } = withIdleHook(fakeContext([], SESSIONS))
    await createInterlintPlugin(run).setup(ctx)
    await done
    await afterTool("subagent", {}, "completed", { sessionID: "main", result: BACKGROUND_STARTED })
    await afterTool("edit", { path: WRITER_FILE }, "completed", { sessionID: "writer" })

    for (let attempt = 0; attempt <= MAX_CONSECUTIVE_BLOCKS; attempt++) await idle("writer")

    expect(runs).toHaveLength(MAX_CONSECUTIVE_BLOCKS + 1)
    expect(sent.filter((message) => message.sessionID === "writer")).toHaveLength(MAX_CONSECUTIVE_BLOCKS)
    expect(sent.at(-1)).toEqual({
      sessionID: "main",
      text: `Interlint: subagent session writer could not make the checks pass after ${MAX_CONSECUTIVE_BLOCKS} attempts, so they are yours to fix.\n\n${VIOLATIONS.output}`,
      resume: true,
    })

    emit(SUCCEEDED, "writer")
    await settled()

    expect(sent.at(-1)).toEqual({
      sessionID: "writer",
      text: `✗ Interlint · checks still fail after ${MAX_CONSECUTIVE_BLOCKS} attempts: architecture. They go to the agent that delegated this work.`,
      resume: false,
    })
  })

  it("hands a subagent's failures to its parent when it is interrupted while its checks run", async () => {
    const { run, finish } = heldChecks()
    const { ctx, sent, done, emit, idle, afterTool } = withIdleHook(fakeContext([], SESSIONS))
    await createInterlintPlugin(run).setup(ctx)
    await done
    await afterTool("subagent", {}, "completed", { sessionID: "main", result: BACKGROUND_STARTED })
    await afterTool("edit", { path: WRITER_FILE }, "completed", { sessionID: "writer" })

    const going = idle("writer")
    await settled()
    emit("session.execution.interrupted", "writer")
    await settled()
    finish(VIOLATIONS)
    await going
    await settled()

    expect(sent).toEqual([
      {
        sessionID: "main",
        text: `Interlint: subagent session writer stopped before the checks passed, so they are yours to fix.\n\n${VIOLATIONS.output}`,
        resume: true,
      },
    ])
  })

  it("makes the main agent's checks wait while a subagent is held, and runs them once it lets go", async () => {
    const { runs, run, finish } = heldChecks()
    const { ctx, done, emit, idle, afterTool } = withIdleHook(fakeContext([], SESSIONS))
    await createInterlintPlugin(run).setup(ctx)
    await done
    await afterTool("edit", { path: WRITER_FILE }, "completed", { sessionID: "writer" })

    const going = idle("writer")
    await settled()
    emit(SUCCEEDED, "main")
    await settled()
    expect(runs).toEqual([WRITER_RUN])

    finish(PASSED)
    await going
    await settled()

    expect(runs).toEqual([WRITER_RUN, TASK_END])
  })

  it("lets a subagent go idle when its checks throw, and stops making the main agent wait for it", async () => {
    const runs: string[][] = []
    const run: RunChecks = async (_directory, _command, _timeoutMs, args = []) => {
      if (args[2] === "edit") return PASSED
      runs.push(args)
      if (args.includes("--file")) throw new Error("spawn failed")
      return PASSED
    }
    const { ctx, done, emit, idle, afterTool } = withIdleHook(fakeContext([], SESSIONS))
    await createInterlintPlugin(run).setup(ctx)
    await done
    await afterTool("edit", { path: WRITER_FILE }, "completed", { sessionID: "writer" })

    await expect(idle("writer")).resolves.toBeUndefined()
    emit(SUCCEEDED, "main")
    await settled()

    expect(runs).toEqual([WRITER_RUN, TASK_END])
  })

  it("runs nothing when a main session, or a subagent that changed no file, would go idle", async () => {
    const { runs, run } = checksGiving(VIOLATIONS)
    const { ctx, sent, done, idle } = withIdleHook(fakeContext([], SESSIONS))
    await createInterlintPlugin(run).setup(ctx)
    await done

    await idle("main")
    await idle("reviewer")

    expect(runs).toEqual([])
    expect(sent).toEqual([])
  })
})

describe("changedFiles", () => {
  it("reads the path of edit and write", () => {
    expect(changedFiles("edit", { path: "src/main/java/shop/Order.java", oldString: "a", newString: "b" })).toEqual([
      "src/main/java/shop/Order.java",
    ])
    expect(changedFiles("write", { path: "C:\\repo\\src\\Order.java", content: "" })).toEqual(["C:\\repo\\src\\Order.java"])
  })

  it("reads every file a patch adds, updates, moves or deletes", () => {
    const patchText = [
      "*** Begin Patch",
      "*** Add File: src/main/java/shop/New.java",
      "+class New {}",
      "*** Update File: src/main/java/shop/Order.java",
      "*** Move to: src/main/java/shop/domain/Order.java",
      "@@ class Order",
      "-int a;",
      "+int b;",
      "*** Delete File: src/main/java/shop/Old.java",
      "*** End Patch",
    ].join("\n")

    expect(changedFiles("patch", { patchText })).toEqual([
      "src/main/java/shop/New.java",
      "src/main/java/shop/Order.java",
      "src/main/java/shop/domain/Order.java",
      "src/main/java/shop/Old.java",
    ])
  })

  it("ignores tools that do not change files", () => {
    expect(changedFiles("read", { path: "src/main/java/shop/Order.java" })).toEqual([])
    expect(changedFiles("shell", { command: "rm Order.java" })).toEqual([])
  })
})

describe("linesWritten", () => {
  it("counts the lines an edit adds or changes, and every line a write gives", () => {
    const edit = { path: "src/A.java", oldString: "    pay();", newString: '    log.info("pay");\n    pay();' }

    expect(linesWritten("edit", edit)).toEqual(new Map([["src/A.java", 1]]))
    expect(linesWritten("write", { path: "src/A.java", content: "class A {\n  int id;\n}\n" })).toEqual(new Map([["src/A.java", 3]]))
  })

  it("counts the added lines of each file of a patch", () => {
    const patchText = [
      "*** Begin Patch",
      "*** Add File: src/main/java/shop/New.java",
      "+class New {",
      "+}",
      "*** Update File: src/main/java/shop/Order.java",
      "*** Move to: src/main/java/shop/domain/Order.java",
      "@@ class Order",
      " int id;",
      "-int a;",
      "+int b;",
      "*** Delete File: src/main/java/shop/Old.java",
      "*** End Patch",
    ].join("\n")

    expect(linesWritten("patch", { patchText })).toEqual(
      new Map([
        ["src/main/java/shop/New.java", 2],
        ["src/main/java/shop/Order.java", 1],
      ]),
    )
  })

  it("counts none for tools that do not change files", () => {
    expect(linesWritten("read", { path: "src/A.java" })).toEqual(new Map())
  })
})

describe("editNote", () => {
  it("shows the failures with the same report the task end shows", () => {
    expect(editNote(VIOLATIONS)).toBe(`Interlint: the checks fail after this edit.\n\n${VIOLATIONS.output}`)
  })

  it("adds nothing when the checks pass or cannot run", () => {
    expect(editNote(PASSED)).toBeUndefined()
    expect(editNote(PASSED_NAMED)).toBeUndefined()
    expect(editNote({ exitCode: 2, output: "interlint: interlint.yaml not found in /repo\n" })).toBeUndefined()
    expect(editNote({ exitCode: 1, output: "'interlint' is not recognized as an internal or external command\n" })).toBeUndefined()
  })
})

describe("OpenCode plugin after an edit", () => {
  it("runs the edit checks for the changed file and appends the failures to the tool result", async () => {
    const runs: { directory: string; args?: string[] }[] = []
    const { ctx, afterTool } = fakeContext()
    await createInterlintPlugin(async (directory, _command, _timeoutMs, args) => {
      runs.push({ directory, args })
      return VIOLATIONS
    }).setup(ctx)

    const event = await afterTool("edit", { path: "src/main/java/shop/Order.java" })

    expect(runs).toEqual([
      { directory: "/repo", args: ["check", "--when", "edit", "--file", "src/main/java/shop/Order.java", "--lines", "0"] },
    ])
    expect(event).toMatchObject({
      result: {
        content: [
          { type: "text", text: "Edited the file" },
          { type: "text", text: `Interlint: the checks fail after this edit.\n\n${VIOLATIONS.output}` },
        ],
      },
    })
  })

  it("tells the session which checks failed after the edit, without resuming it, since OpenCode Desktop does not show tool results", async () => {
    const { ctx, sent, labels, afterTool } = fakeContext()
    const failed: CheckRun = {
      exitCode: 1,
      output: [
        "✗ architecture · ARCH-01: rule",
        "",
        "✗ architecture · ARCH-03: rule",
        "",
        "✗ orders/pmd · EmptyCatchBlock",
        "",
        "Fix these problems before continuing.",
        "",
      ].join("\n"),
    }
    await createInterlintPlugin(async () => failed).setup(ctx)

    const event = await afterTool("write", { path: "src/main/java/shop/Order.java", content: "" })

    const line = "✗ Interlint · checks failed after this edit: architecture, orders/pmd"
    expect(event).toMatchObject({ result: { content: [{ type: "text", text: "Edited the file" }, { type: "text" }] } })
    expect(sent).toEqual([{ sessionID: "s1", text: line, resume: false }])
    expect(labels).toEqual([line])
  })

  it("tells the session nothing when the edit checks could not run", async () => {
    const { ctx, sent, afterTool } = fakeContext()
    await createInterlintPlugin(async () => ({ exitCode: 2, output: "interlint: interlint.yaml not found in /repo\n" })).setup(ctx)

    await afterTool("write", { path: "src/main/java/shop/Order.java", content: "" })

    expect(sent).toEqual([])
  })

  it("gives the checks the lines the edit wrote in each file", async () => {
    const runs: (string[] | undefined)[] = []
    const { ctx, afterTool } = fakeContext()
    await createInterlintPlugin(async (_directory, _command, _timeoutMs, args) => (runs.push(args), PASSED)).setup(ctx)

    await afterTool("write", { path: "src/main/java/shop/Order.java", content: "class Order {\n}\n" })

    expect(runs).toEqual([["check", "--when", "edit", "--file", "src/main/java/shop/Order.java", "--lines", "2"]])
  })

  it("tells the session which checks passed, without resuming it, since OpenCode Desktop does not show tool results", async () => {
    const { ctx, sent, labels, afterTool } = fakeContext()
    await createInterlintPlugin(async () => PASSED_NAMED).setup(ctx)

    const event = await afterTool("write", { path: "src/main/java/shop/Order.java", content: "" })

    expect(event).toMatchObject({ result: { content: [{ type: "text", text: "Edited the file" }] } })
    expect(sent).toEqual([{ sessionID: "s1", text: PASS_LINE, resume: false }])
    expect(labels).toEqual([PASS_LINE])
  })

  it("leaves the edit as it was when that message cannot be sent", async () => {
    const { ctx, afterTool } = fakeContext([], {}, ["s1"])
    await createInterlintPlugin(async () => PASSED_NAMED).setup(ctx)

    const event = await afterTool("write", { path: "src/main/java/shop/Order.java", content: "" })

    expect(event).toMatchObject({ result: { content: [{ type: "text", text: "Edited the file" }] } })
  })

  it("leaves the tool result as it was and sends nothing when no check ran", async () => {
    const { ctx, sent, afterTool } = fakeContext()
    await createInterlintPlugin(async () => PASSED).setup(ctx)

    const event = await afterTool("write", { path: "src/main/java/shop/Order.java", content: "" })

    expect(event).toMatchObject({ result: { content: [{ type: "text", text: "Edited the file" }] } })
    expect(sent).toEqual([])
  })

  it("does not run checks for tools that change no file, or for failed edits", async () => {
    const runs: string[] = []
    const { ctx, afterTool } = fakeContext()
    await createInterlintPlugin(async (directory) => {
      runs.push(directory)
      return VIOLATIONS
    }).setup(ctx)

    await afterTool("read", { path: "src/main/java/shop/Order.java" })
    await afterTool("edit", { path: "src/main/java/shop/Order.java" }, "error")

    expect(runs).toEqual([])
  })

  it("skips a path the shell could misread, instead of passing it to the command line", async () => {
    const runs: (string[] | undefined)[] = []
    const { ctx, afterTool } = fakeContext()
    await createInterlintPlugin(async (_directory, _command, _timeoutMs, args) => {
      runs.push(args)
      return PASSED
    }).setup(ctx)

    await afterTool("edit", { path: 'src/$(touch x)/A".java' })
    // A trailing backslash would escape the closing quote under sh.
    await afterTool("write", { path: "src\\main\\java\\" })

    expect(runs).toEqual([])
  })

  it("gives an edit check a shorter timeout than the task end, since the agent waits for it", async () => {
    const timeouts: number[] = []
    const record = async (_directory: string, _command: string, timeoutMs: number) => {
      timeouts.push(timeoutMs)
      return PASSED
    }
    const byDefault = fakeContext()
    await createInterlintPlugin(record).setup(byDefault.ctx)
    await byDefault.afterTool("edit", { path: "src/main/java/shop/Order.java" })
    const configured = fakeContext()
    configured.ctx.options = { editTimeoutMs: 5_000 }
    await createInterlintPlugin(record).setup(configured.ctx)
    await configured.afterTool("edit", { path: "src/main/java/shop/Order.java" })

    expect(timeouts).toEqual([DEFAULT_EDIT_TIMEOUT_MS, 5_000])
    expect(DEFAULT_EDIT_TIMEOUT_MS).toBeLessThan(DEFAULT_TIMEOUT_MS)
  })
})

describe("runInterlint arguments", () => {
  let scratch: string

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "interlint-plugin-"))
  })

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  it("passes a file path with spaces and accents as one argument", async () => {
    writeFileSync(join(scratch, "argv.mjs"), "console.log(JSON.stringify(process.argv.slice(2)))\n")

    const run = await runInterlint(scratch, "node argv.mjs", 10_000, ["check", "--when", "edit", "--file", "src/Mi Pedido/Ñandú.java"])

    expect(JSON.parse(run.output)).toEqual(["check", "--when", "edit", "--file", "src/Mi Pedido/Ñandú.java"])
  })
})

describe("the agent's context for the metrics", () => {
  type ModelRequest = { sessionID: string; kind: string; agent?: string; model: { id: string; providerID: string; variant?: string } }

  /** Fake checks that record the context of each run, and a `model.request` hook the test can fire. */
  function recording(ctx: ReturnType<typeof fakeContext>["ctx"]) {
    const contexts: { args: string[]; context: unknown }[] = []
    let request: ((event: ModelRequest) => void) | undefined
    Object.assign(ctx.session, {
      hook: async (name: string, callback: (event: ModelRequest) => void) => {
        if (name === "model.request") request = callback
        return { dispose: async () => {} }
      },
    })
    const run: RunChecks = async (_directory, _command, _timeoutMs, args = [], context) => {
      contexts.push({ args, context })
      return PASSED
    }
    return { contexts, run, modelRequest: (event: ModelRequest) => request?.(event) }
  }

  it("gives an edit's checks the session and the model of its last request, leaving out the title's", async () => {
    const { ctx, afterTool } = fakeContext()
    const { contexts, run, modelRequest } = recording(ctx)
    await createInterlintPlugin(run).setup(ctx)

    modelRequest({ sessionID: "s1", kind: "primary", model: { id: "gpt-4.1", providerID: "openai", variant: "default" } })
    modelRequest({ sessionID: "s1", kind: "title", model: { id: "gpt-6-luna", providerID: "openai" } })
    await afterTool("edit", { path: "src/main/java/shop/Order.java" })

    expect(contexts[0]?.context).toEqual({ agent: "opencode", session: "s1", model: "gpt-4.1", provider: "openai" })
  })

  it("gives a subagent's checks its type and its own model", async () => {
    const { ctx, afterTool, emit } = fakeContext([], { writer: { parentID: "s1", agent: "explore" } })
    const { contexts, run, modelRequest } = recording(ctx)
    await createInterlintPlugin(run).setup(ctx)

    modelRequest({ sessionID: "writer", kind: "primary", model: { id: "gpt-4.1-mini", providerID: "openai" } })
    await afterTool("edit", { path: "src/main/java/shop/Order.java" }, "completed", { sessionID: "writer" })
    emit(SUCCEEDED, "writer")
    await settled()
    await settled()

    const expected = { agent: "opencode", session: "writer", subagent: true, agentType: "explore", model: "gpt-4.1-mini", provider: "openai" }
    expect(contexts.map(({ context }) => context)).toEqual([expected, expected])
    expect(contexts[1]?.args[2]).toBe("task-end")
  })

  it("asks the session for its model when no request gave it", async () => {
    const { ctx, afterTool } = fakeContext([], { s1: { model: { id: "claude-sonnet-5-5", providerID: "anthropic" } } })
    const { contexts, run } = recording(ctx)
    await createInterlintPlugin(run).setup(ctx)

    await afterTool("edit", { path: "src/main/java/shop/Order.java" })

    expect(contexts[0]?.context).toMatchObject({ model: "claude-sonnet-5-5", provider: "anthropic" })
  })

  it("still runs the checks when the session hook throws as the plugin starts", async () => {
    const runs: unknown[] = []
    const { ctx, afterTool } = fakeContext()
    Object.assign(ctx.session, {
      hook: () => {
        throw new Error("no such hook")
      },
    })
    await createInterlintPlugin(async (_directory, _command, _timeoutMs, _args, context) => {
      runs.push(context)
      return PASSED
    }).setup(ctx)

    await afterTool("edit", { path: "src/main/java/shop/Order.java" })

    expect(runs).toEqual([{ agent: "opencode", session: "s1" }])
  })

  it("still runs the checks, without a model, on an OpenCode that has no session hooks", async () => {
    const runs: unknown[] = []
    const { ctx, afterTool } = fakeContext()
    await createInterlintPlugin(async (_directory, _command, _timeoutMs, _args, context) => {
      runs.push(context)
      return PASSED
    }).setup(ctx)

    await afterTool("edit", { path: "src/main/java/shop/Order.java" })

    expect(runs).toEqual([{ agent: "opencode", session: "s1" }])
  })
})

describe("runInterlint with the agent's context", () => {
  let scratch: string

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "interlint-plugin-"))
  })

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  it("adds --agent-context and writes the context as JSON on stdin", async () => {
    writeFileSync(
      join(scratch, "argv.mjs"),
      `let input = ""
process.stdin.on("data", (chunk) => (input += chunk))
process.stdin.on("end", () => console.log(JSON.stringify({ args: process.argv.slice(2), input })))
`,
    )
    const context = { agent: "opencode" as const, session: "ses_1", model: "gpt-4.1", provider: "openai" }

    const run = await runInterlint(scratch, "node argv.mjs", 10_000, ["check", "--when", "task-end"], context)

    expect(JSON.parse(run.output)).toEqual({ args: ["check", "--when", "task-end", "--agent-context"], input: JSON.stringify(context) })
  })
})

describe("OpenCode plugin with protected files", () => {
  const QUESTION =
    "Interlint: the agent wants to change interlint.yaml, protected in interlint.yaml because it defines the project's rules. Allow it only if the task needs this change.\n"

  /** Fake checks that record every run with its arguments, and answer pre-edit with the question for `interlint.yaml`. */
  function recordingChecks() {
    const runs: { args: string[]; context?: unknown }[] = []
    const run: RunChecks = async (_directory, _command, _timeoutMs, args = [], context) => {
      runs.push({ args, context })
      if (args[2] === "pre-edit") return { exitCode: 0, output: args.includes("interlint.yaml") ? QUESTION : "" }
      return PASSED
    }
    return { runs, run }
  }

  /** A context whose OpenCode gives plugins the permission hook. */
  function withPermissions(ctx: ReturnType<typeof fakeContext>["ctx"]) {
    let evaluate: ((event: PermissionEvaluation) => Promise<void> | void) | undefined
    const permission = {
      hook: async (_name: "evaluate", callback: (event: PermissionEvaluation) => Promise<void> | void) => {
        evaluate = callback
        return { dispose: async () => {} }
      },
    }
    return { ctx: Object.assign(ctx, { permission }), evaluate: async (event: PermissionEvaluation) => evaluate?.(event) }
  }

  const permissionEvent = (action: string, resource: string): PermissionEvaluation => ({
    sessionID: "s1",
    action,
    resources: [resource],
    effect: "allow",
  })

  it("keeps the protected files once when a main session's first turn starts, not for a subagent", async () => {
    const { runs, run } = recordingChecks()
    const { ctx, done, emit } = fakeContext([], { writer: { parentID: "main" } })
    await createInterlintPlugin(run).setup(ctx)
    await done

    emit("session.execution.started", "main")
    emit("session.execution.started", "writer")
    emit("session.execution.started", "main")
    await settled()
    await settled()

    expect(runs).toEqual([{ args: ["check", "--when", "session-start"], context: { agent: "opencode", session: "main" } }])
  })

  it("makes OpenCode ask the user before an edit changes a protected file", async () => {
    const { run } = recordingChecks()
    const fake = fakeContext()
    const { ctx, evaluate } = withPermissions(fake.ctx)
    await createInterlintPlugin(run).setup(ctx)
    await fake.done

    const guarded = permissionEvent("edit", "interlint.yaml")
    const free = permissionEvent("edit", "src/Order.ts")
    const read = permissionEvent("read", "interlint.yaml")
    await evaluate(guarded)
    await evaluate(free)
    await evaluate(read)

    expect(guarded).toMatchObject({ effect: "ask", message: QUESTION.trim() })
    expect(free).toEqual(permissionEvent("edit", "src/Order.ts"))
    expect(read).toEqual(permissionEvent("read", "interlint.yaml"))
  })

  it("tells the CLI the main session when a subagent edits, as the protected files are kept for it", async () => {
    const { runs, run } = recordingChecks()
    const fake = fakeContext([], { writer: { parentID: "main" } })
    await createInterlintPlugin(run).setup(withPermissions(fake.ctx).ctx)
    await fake.done

    await fake.afterTool("edit", { path: "/repo/src/Order.ts" }, "completed", { sessionID: "writer" })
    await fake.afterTool("edit", { path: "/repo/src/Order.ts" }, "completed", { sessionID: "main" })

    const edits = runs.filter(({ args }) => args[2] === "edit").map(({ args }) => args)
    expect(edits[0]).toEqual(expect.arrayContaining(["--root-session", "main"]))
    expect(edits[1]).not.toContain("--root-session")
  })

  it("never tells the CLI that an edit was approved: OpenCode Desktop grants an ask without showing it", async () => {
    const { runs, run } = recordingChecks()
    const fake = fakeContext()
    await createInterlintPlugin(run).setup(withPermissions(fake.ctx).ctx)
    await fake.done
    await fake.afterTool("edit", { path: "/repo/src/Order.ts" })
    fake.emit("session.execution.succeeded", "s1")
    await settled()

    expect(runs.filter(({ args }) => args.includes("--asked"))).toEqual([])
  })
})

describe("pausing Interlint in an OpenCode session", () => {
  /** Fake checks that record every run of the CLI, with a `prompt` session hook the test can fire. */
  function pausable(events: PluginEvent[] = [], sessions: Parameters<typeof fakeContext>[1] = {}) {
    const fake = fakeContext(events, sessions)
    const runs: { args: string[]; context: unknown }[] = []
    let onPrompt: ((event: { sessionID: string; prompt?: { text?: unknown } }) => Promise<void> | void) | undefined
    Object.assign(fake.ctx.session, {
      hook: async (name: string, callback: typeof onPrompt) => {
        if (name === "prompt") onPrompt = callback
        return { dispose: async () => {} }
      },
    })
    const run: RunChecks = async (_directory, _command, _timeoutMs, args = [], context) => {
      runs.push({ args, context })
      return args[2] === "task-end" ? VIOLATIONS : PASSED
    }
    const prompt = async (text: string, sessionID = "main") => {
      await onPrompt?.({ sessionID, prompt: { text } })
      await settled()
    }
    return { ...fake, runs, run, prompt }
  }

  it("finds the marks as the CLI does", () => {
    for (const text of ["interlint: pause", "Do X. INTERLINT: Resume", "interlint:pause then interlint: resume", "interlint: paused", "pause", 'a "interlint: pause" b']) {
      expect(pauseMark(text)).toBe(pauseMarkOf(text))
    }
    expect(pauseMark(undefined)).toBeUndefined()
  })

  it("pauses a main session, tells the CLI and confirms it to the user", async () => {
    const { ctx, run, runs, sent, prompt } = pausable()
    await createInterlintPlugin(run).setup(ctx)

    await prompt("Change only the label. interlint: PAUSE")

    expect(runs).toEqual([{ args: ["check", "--when", "pause"], context: { agent: "opencode", session: "main" } }])
    expect(sent).toEqual([{ sessionID: "main", text: PAUSED_MESSAGE, resume: false }])
  })

  it("runs nothing while paused, in the main agent and its subagents, and reminds the user at each turn end", async () => {
    const { ctx, run, runs, sent, prompt, afterTool, emit } = pausable([], SESSIONS)
    await createInterlintPlugin(run).setup(ctx)
    await prompt("interlint: pause")
    runs.length = 0
    sent.length = 0

    const edited = await afterTool("edit", { path: "src/main/java/shop/Order.java" }, "completed", { sessionID: "main" })
    await afterTool("edit", { path: WRITER_FILE }, "completed", { sessionID: "writer" })
    emit(SUCCEEDED, "writer")
    await settled()
    emit(SUCCEEDED, "main")
    await settled()
    await settled()

    expect(runs).toEqual([])
    expect(edited.result).toEqual({ content: [{ type: "text", text: "Edited the file" }] })
    expect(sent).toEqual([{ sessionID: "main", text: PAUSED_REMINDER, resume: false }])
  })

  it("resumes, tells the CLI to restart the session and checks the next turn again", async () => {
    const { ctx, run, runs, sent, prompt, emit } = pausable()
    await createInterlintPlugin(run).setup(ctx)
    await prompt("interlint: pause")

    await prompt("interlint: resume")
    emit(SUCCEEDED, "main")
    await settled()
    await settled()

    expect(runs.map(({ args }) => args)).toEqual([["check", "--when", "pause"], ["check", "--when", "resume"], TASK_END])
    expect(sent[1]).toEqual({ sessionID: "main", text: RESUMED_MESSAGE, resume: false })
    expect(sent[2]).toMatchObject({ sessionID: "main", resume: true, text: expect.stringContaining("attempt 1 of 3") })
  })

  it("starts counting the blocks from zero after a resume", async () => {
    const { ctx, run, sent, prompt, emit } = pausable()
    await createInterlintPlugin(run).setup(ctx)
    emit(SUCCEEDED, "main")
    await settled()
    emit(SUCCEEDED, "main")
    await settled()
    expect(sent.at(-1)?.text).toContain("attempt 2 of 3")

    await prompt("interlint: pause")
    await prompt("interlint: resume")
    emit(SUCCEEDED, "main")
    await settled()
    await settled()

    expect(sent.at(-1)?.text).toContain("attempt 1 of 3")
  })

  it("tells the user Interlint was not paused when they resume an active session", async () => {
    const { ctx, run, runs, sent, prompt } = pausable()
    await createInterlintPlugin(run).setup(ctx)

    await prompt("interlint: resume")

    expect(runs).toEqual([])
    expect(sent).toEqual([{ sessionID: "main", text: NOT_PAUSED_MESSAGE, resume: false }])
  })

  it("ignores a mark in a subagent's prompt, which the agent writes", async () => {
    const { ctx, run, runs, sent, prompt, emit } = pausable([], SESSIONS)
    await createInterlintPlugin(run).setup(ctx)

    await prompt("interlint: pause", "writer")
    emit(SUCCEEDED, "main")
    await settled()
    await settled()

    expect(runs.map(({ args }) => args)).toEqual([TASK_END])
    expect(sent).toEqual([expect.objectContaining({ sessionID: "main", resume: true })])
  })

  it("pauses only its own session", async () => {
    const { ctx, run, runs, prompt, emit } = pausable()
    await createInterlintPlugin(run).setup(ctx)

    await prompt("interlint: pause", "main")
    emit(SUCCEEDED, "other")
    await settled()
    await settled()

    expect(runs.map(({ args }) => args)).toEqual([["check", "--when", "pause"], TASK_END])
  })

  it("starts the turn in the CLI on a prompt without a mark, and tells the user nothing", async () => {
    const { ctx, run, runs, sent, prompt } = pausable()
    await createInterlintPlugin(run).setup(ctx)

    await prompt("Add a discount to the order")

    expect(runs).toEqual([{ args: ["check", "--when", "turn-start"], context: { agent: "opencode", session: "main" } }])
    expect(sent).toEqual([])
  })

  it("starts no turn for a subagent's prompt or in a paused session", async () => {
    const { ctx, run, runs, prompt } = pausable([], SESSIONS)
    await createInterlintPlugin(run).setup(ctx)
    await prompt("interlint: pause")
    runs.length = 0

    await prompt("Add a discount to the order")
    await prompt("Write the tests", "writer")

    expect(runs).toEqual([])
  })
})

describe("telling the user that the task-end checks are running", () => {
  const RUNNING = "Interlint: running checks"
  const DELAY = 2_000
  beforeEach(() => void vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }))
  afterEach(() => void vi.useRealTimers())

  type FakeContext = ReturnType<typeof fakeContext>["ctx"]
  const FINISHED = "Interlint: checks finished"

  /** Task-end checks that end with `result` once `finish` is called. */
  function slowChecks(result: CheckRun) {
    let finish!: () => void
    const ended = new Promise<void>((resolve) => (finish = resolve))
    const run: RunChecks = async (_directory, _command, _timeoutMs, args = []) => {
      if (args[2] === "task-end") await ended
      return result
    }
    return { run, finish }
  }

  async function turnEnd(run: RunChecks, options: Record<string, unknown> = {}, setUp?: (ctx: FakeContext) => void) {
    const context = fakeContext([{ type: SUCCEEDED, data: { sessionID: "s1" } }])
    context.ctx.options = options
    setUp?.(context.ctx)
    await createInterlintPlugin(run).setup(context.ctx)
    await context.done
    await settled()
    return context
  }

  it("sends a message saying the checks are running when they take longer than 2 seconds, before their result", async () => {
    const { run, finish } = slowChecks(PASSED_NAMED)
    const { sent, labels } = await turnEnd(run)

    vi.advanceTimersByTime(DELAY)
    await settled()
    expect(sent).toEqual([{ sessionID: "s1", text: RUNNING, resume: false }])
    expect(labels).toEqual([RUNNING])

    finish()
    await settled()
    expect(sent).toEqual([
      { sessionID: "s1", text: RUNNING, resume: false },
      { sessionID: "s1", text: PASS_LINE, resume: false },
    ])
  })

  it("says nothing more when the checks end within 2 seconds, such as when no project changed", async () => {
    const { run, finish } = slowChecks(PASSED)
    const { sent } = await turnEnd(run)

    vi.advanceTimersByTime(DELAY - 1)
    finish()
    await settled()
    vi.advanceTimersByTime(DELAY)
    await settled()

    expect(sent).toEqual([])
  })

  it("still makes the agent fix the failures after saying the checks are running", async () => {
    const { run, finish } = slowChecks(VIOLATIONS)
    const { sent } = await turnEnd(run)

    vi.advanceTimersByTime(DELAY)
    await settled()
    finish()
    await settled()

    expect(sent.map(({ text, resume }) => ({ running: text === RUNNING, resume }))).toEqual([
      { running: true, resume: false },
      { running: false, resume: true },
    ])
  })

  it("closes the notice with a line when the checks end with nothing to report, so the user is not left waiting", async () => {
    const { run, finish } = slowChecks(PASSED)
    const { sent } = await turnEnd(run)

    vi.advanceTimersByTime(DELAY)
    await settled()
    finish()
    await settled()

    expect(sent).toEqual([
      { sessionID: "s1", text: RUNNING, resume: false },
      { sessionID: "s1", text: FINISHED, resume: false },
    ])
  })

  it("follows the notice with the error when the checks cannot run", async () => {
    const { run, finish } = slowChecks({ exitCode: 2, output: "Error: no interlint.yaml\n" })
    const { sent } = await turnEnd(run)

    vi.advanceTimersByTime(DELAY)
    await settled()
    finish()
    await settled()

    expect(sent.map(({ text, resume }) => ({ text: text.split("\n")[0], resume }))).toEqual([
      { text: RUNNING, resume: false },
      { text: "Interlint could not run the checks (exit code 2).", resume: false },
    ])
  })

  it("waits as long as the runningNoticeMs option says before sending the notice", async () => {
    const { run } = slowChecks(PASSED_NAMED)
    const { sent } = await turnEnd(run, { runningNoticeMs: 500 })

    vi.advanceTimersByTime(499)
    await settled()
    expect(sent).toEqual([])

    vi.advanceTimersByTime(1)
    await settled()
    expect(sent).toEqual([{ sessionID: "s1", text: RUNNING, resume: false }])
  })

  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY, "500"])(
    "keeps the 2-second delay when runningNoticeMs is %s, which is not a delay",
    async (runningNoticeMs) => {
      const { run } = slowChecks(PASSED_NAMED)
      const { sent } = await turnEnd(run, { runningNoticeMs })

      vi.advanceTimersByTime(DELAY - 1)
      await settled()
      expect(sent).toEqual([])

      vi.advanceTimersByTime(1)
      await settled()
      expect(sent).toEqual([{ sessionID: "s1", text: RUNNING, resume: false }])
    },
  )

  it("still sends the result when the notice cannot be sent", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    const { run, finish } = slowChecks(PASSED_NAMED)
    const { sent } = await turnEnd(run, {}, (ctx) => {
      const synthetic = ctx.session.synthetic
      ctx.session.synthetic = async (input) => {
        if (input.text === RUNNING) throw new Error("synthetic failed")
        return synthetic(input)
      }
    })

    vi.advanceTimersByTime(DELAY)
    await settled()
    finish()
    await settled()

    expect(sent).toEqual([{ sessionID: "s1", text: PASS_LINE, resume: false }])
    expect(errors).toHaveBeenCalled()
    errors.mockRestore()
  })

  it("sends the result after 5 seconds when the notice never finishes sending", async () => {
    const { run, finish } = slowChecks(VIOLATIONS)
    const { sent } = await turnEnd(run, {}, (ctx) => {
      const synthetic = ctx.session.synthetic
      ctx.session.synthetic = (input) => (input.text === RUNNING ? new Promise<void>(() => {}) : synthetic(input))
    })

    vi.advanceTimersByTime(DELAY)
    await settled()
    finish()
    await settled()
    vi.advanceTimersByTime(4_999)
    await settled()
    expect(sent).toEqual([])

    vi.advanceTimersByTime(1)
    await settled()
    expect(sent.map(({ resume }) => resume)).toEqual([true])
  })

  describe("in a subagent", () => {
    /** The subagent `writer` edits a file and ends its turn; its task-end checks give `results` in turn. */
    async function writerTurnEnd(...results: CheckRun[]) {
      return writerTurnEndWith(undefined, ...results)
    }

    async function writerTurnEndWith(setUp: ((ctx: FakeContext) => void) | undefined, ...results: CheckRun[]) {
      let finish!: () => void
      const ended = new Promise<void>((resolve) => (finish = resolve))
      const run: RunChecks = async (_directory, _command, _timeoutMs, args = []) => {
        if (args[2] !== "task-end") return PASSED
        await ended
        return results.shift() ?? PASSED
      }
      const context = fakeContext([], SESSIONS)
      setUp?.(context.ctx)
      await createInterlintPlugin(run).setup(context.ctx)
      await context.done
      await context.afterTool("edit", { path: WRITER_FILE }, "completed", { sessionID: "writer" })
      context.emit(SUCCEEDED, "writer")
      await settled()
      return { ...context, finish }
    }

    it("says the checks are running after 2 seconds and then which passed, before the answer reaches the main agent", async () => {
      const { sent, afterTool, finish } = await writerTurnEnd(PASSED_NAMED)
      let answered = false
      const answer = afterTool("subagent", {}, "completed", { sessionID: "main", result: subagentAnswer })
      void answer.then(() => (answered = true))

      vi.advanceTimersByTime(DELAY)
      await settled()
      expect(sent).toEqual([{ sessionID: "writer", text: RUNNING, resume: false }])
      expect(answered).toBe(false)

      finish()
      await settled()
      expect(sent).toEqual([
        { sessionID: "writer", text: RUNNING, resume: false },
        { sessionID: "writer", text: PASS_LINE, resume: false },
      ])
      expect((await answer).result).toEqual(subagentAnswer)
    })

    it("says which checks passed even when they end within 2 seconds", async () => {
      const { sent, finish } = await writerTurnEnd(PASSED_NAMED)

      finish()
      await settled()

      expect(sent).toEqual([{ sessionID: "writer", text: PASS_LINE, resume: false }])
    })

    it("closes the notice when the checks pass with nothing to name", async () => {
      const { sent, finish } = await writerTurnEnd(PASSED)

      vi.advanceTimersByTime(DELAY)
      await settled()
      finish()
      await settled()

      expect(sent).toEqual([
        { sessionID: "writer", text: RUNNING, resume: false },
        { sessionID: "writer", text: FINISHED, resume: false },
      ])
    })

    it("follows the notice with the failures that resume the subagent", async () => {
      const { sent, finish } = await writerTurnEnd(VIOLATIONS)

      vi.advanceTimersByTime(DELAY)
      await settled()
      finish()
      await settled()

      expect(sent.map(({ sessionID, text, resume }) => ({ sessionID, text: text.split("\n")[0], resume }))).toEqual([
        { sessionID: "writer", text: RUNNING, resume: false },
        { sessionID: "writer", text: `Interlint: the task cannot end yet (attempt 1 of ${MAX_CONSECUTIVE_BLOCKS}).`, resume: true },
      ])
    })

    /** The messages the user reads in the subagent's session that do not resume it. */
    const writerLines = (sent: { sessionID: string; text: string; resume?: boolean }[]) =>
      sent.filter(({ sessionID, resume }) => sessionID === "writer" && resume === false).map(({ text }) => text)

    it("follows the notice with a line naming the checks that still fail after the last attempt", async () => {
      const { sent, emit, finish } = await writerTurnEnd(VIOLATIONS, VIOLATIONS, VIOLATIONS, VIOLATIONS)

      vi.advanceTimersByTime(DELAY)
      await settled()
      finish()
      await settled()
      for (let attempt = 0; attempt < MAX_CONSECUTIVE_BLOCKS; attempt++) await writerTurn(emit)

      expect(writerLines(sent)).toEqual([
        RUNNING,
        `✗ Interlint · checks still fail after ${MAX_CONSECUTIVE_BLOCKS} attempts: architecture. They go to the agent that delegated this work.`,
      ])
    })

    it("leaves the names out of that line when the failures name no check", async () => {
      const unnamed: CheckRun = { exitCode: 1, output: "✗ the build broke\n" }
      const { sent, emit, finish } = await writerTurnEnd(unnamed, unnamed, unnamed, unnamed)

      finish()
      await settled()
      for (let attempt = 0; attempt < MAX_CONSECUTIVE_BLOCKS; attempt++) await writerTurn(emit)

      expect(writerLines(sent)).toEqual([
        `✗ Interlint · checks still fail after ${MAX_CONSECUTIVE_BLOCKS} attempts. They go to the agent that delegated this work.`,
      ])
    })

    it("follows the notice with a line when the checks cannot run", async () => {
      const { sent, finish } = await writerTurnEnd({ exitCode: 2, output: "Error: no interlint.yaml\n" })

      vi.advanceTimersByTime(DELAY)
      await settled()
      finish()
      await settled()

      expect(writerLines(sent)).toEqual([RUNNING, "Interlint could not run the checks (exit code 2)."])
    })

    it("gives the main agent the answer after 5 seconds when the line of the result never finishes sending", async () => {
      const { afterTool, finish } = await writerTurnEndWith((ctx) => {
        const synthetic = ctx.session.synthetic
        ctx.session.synthetic = (input) => (input.text === PASS_LINE ? new Promise<void>(() => {}) : synthetic(input))
      }, PASSED_NAMED)
      let answered = false
      const answer = afterTool("subagent", {}, "completed", { sessionID: "main", result: subagentAnswer })
      void answer.then(() => (answered = true))

      finish()
      await settled()
      vi.advanceTimersByTime(4_999)
      await settled()
      expect(answered).toBe(false)

      vi.advanceTimersByTime(1)
      await settled()
      expect(answered).toBe(true)
      expect((await answer).result).toEqual(subagentAnswer)
    })
  })
})
