import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import plugin, {
  type CheckRun,
  changedFiles,
  createInterlintPlugin,
  DEFAULT_EDIT_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  editNote,
  MAX_CONSECUTIVE_BLOCKS,
  MAX_OUTPUT_CHARS,
  type RunChecks,
  runInterlint,
  TaskEndGate,
} from "../integrations/opencode/interlint/index.js"

const VIOLATIONS: CheckRun = { exitCode: 1, output: "✗ architecture · ARCH-01: rule\n\nFix these problems before continuing.\n" }
const PASSED: CheckRun = { exitCode: 0, output: "" }

describe("TaskEndGate", () => {
  it("lets the task end when the checks pass", () => {
    expect(new TaskEndGate().decide("s1", PASSED)).toEqual({ action: "none" })
  })

  it("makes the agent continue with the failures, counting the attempts", () => {
    const gate = new TaskEndGate()

    expect(gate.decide("s1", VIOLATIONS)).toEqual({
      action: "continue",
      text: `Interlint: the task cannot end yet (attempt 1 of ${MAX_CONSECUTIVE_BLOCKS}).\n\n${VIOLATIONS.output}`,
    })
    expect(gate.decide("s1", VIOLATIONS)).toMatchObject({ action: "continue", text: expect.stringContaining("attempt 2 of 3") })
  })

  it("stops blocking after the limit and only reports", () => {
    const gate = new TaskEndGate()
    for (let attempt = 0; attempt < MAX_CONSECUTIVE_BLOCKS; attempt++) gate.decide("s1", VIOLATIONS)

    expect(gate.decide("s1", VIOLATIONS)).toEqual({
      action: "report",
      text: `Interlint: the checks still fail after ${MAX_CONSECUTIVE_BLOCKS} attempts, so the task may end.\n\n${VIOLATIONS.output}`,
    })
    expect(gate.decide("s1", VIOLATIONS)).toMatchObject({ action: "continue", text: expect.stringContaining("attempt 1 of 3") })
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
 * `sessions` maps a session ID to its parent, for the sessions a subagent runs in, and to how many lookups fail first.
 * Sending a message to a session in `failingSynthetic` throws.
 */
function fakeContext(
  events: PluginEvent[] = [],
  sessions: Record<string, { parentID?: string; failedLookups?: number }> = {},
  failingSynthetic: string[] = [],
) {
  const sent: { sessionID: string; text: string; resume?: boolean }[] = []
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
        if (session?.failedLookups) {
          session.failedLookups--
          throw new Error("Session lookup failed")
        }
        return { id: input.sessionID, parentID: session?.parentID }
      },
      synthetic: async (input: { sessionID: string; text: string; resume?: boolean }) => {
        if (failingSynthetic.includes(input.sessionID)) throw new Error("synthetic failed")
        sent.push({ sessionID: input.sessionID, text: input.text, resume: input.resume })
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
  return { ctx, sent, done, emit, afterTool }
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

  it("resumes the session with the failures", async () => {
    const { ctx, sent, done } = fakeContext([{ type: SUCCEEDED, data: { sessionID: "s1" } }])

    await createInterlintPlugin(async () => VIOLATIONS).setup(ctx)
    await done
    await settled()

    expect(sent).toEqual([{ sessionID: "s1", text: expect.stringContaining("ARCH-01: rule"), resume: true }])
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
    for (let attempt = 0; attempt < MAX_CONSECUTIVE_BLOCKS; attempt++) await writerTurn(emit)

    expect((await answer).result?.content).toBe(
      `${ANSWER}\n\nInterlint: the subagent could not make the checks pass after ${MAX_CONSECUTIVE_BLOCKS} attempts, so they are yours to fix.\n\n${VIOLATIONS.output}`,
    )
    expect(runs).toHaveLength(MAX_CONSECUTIVE_BLOCKS + 1)
    expect(sent.map((message) => message.sessionID)).toEqual(["writer", "writer", "writer"])
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
    const { ctx, done, emit, afterTool } = fakeContext([], { writer: { parentID: "main", failedLookups: 1 } })
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

describe("editNote", () => {
  it("shows the failures with the same report the task end shows", () => {
    expect(editNote(VIOLATIONS)).toBe(`Interlint: the checks fail after this edit.\n\n${VIOLATIONS.output}`)
  })

  it("adds nothing when the checks pass or cannot run", () => {
    expect(editNote(PASSED)).toBeUndefined()
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

    expect(runs).toEqual([{ directory: "/repo", args: ["check", "--when", "edit", "--file", "src/main/java/shop/Order.java"] }])
    expect(event).toMatchObject({
      result: {
        content: [
          { type: "text", text: "Edited the file" },
          { type: "text", text: `Interlint: the checks fail after this edit.\n\n${VIOLATIONS.output}` },
        ],
      },
    })
  })

  it("leaves the tool result as it was when the checks pass", async () => {
    const { ctx, afterTool } = fakeContext()
    await createInterlintPlugin(async () => PASSED).setup(ctx)

    const event = await afterTool("write", { path: "src/main/java/shop/Order.java", content: "" })

    expect(event).toMatchObject({ result: { content: [{ type: "text", text: "Edited the file" }] } })
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
