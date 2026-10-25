import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import plugin, {
  type CheckRun,
  changedFiles,
  createInterlintPlugin,
  DEFAULT_EDIT_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  editNote,
  MAX_CONSECUTIVE_BLOCKS,
  MAX_OUTPUT_CHARS,
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

/** A fake OpenCode V2 plugin context that records what the plugin sends to the session. */
function fakeContext(events: { type: string; data?: { sessionID?: string } }[] = []) {
  const sent: { sessionID: string; text: string; resume?: boolean }[] = []
  const hooks = new Map<string, (event: ToolEvent) => Promise<void> | void>()
  let finished!: () => void
  const done = new Promise<void>((resolve) => (finished = resolve))
  const ctx = {
    location: { directory: "/repo" },
    options: {} as Record<string, unknown>,
    session: {
      synthetic: async (input: { sessionID: string; text: string; resume?: boolean }) => {
        sent.push({ sessionID: input.sessionID, text: input.text, resume: input.resume })
      },
    },
    event: {
      subscribe: async function* () {
        for (const event of events) yield event
        finished()
      },
    },
    tool: {
      hook: async (name: string, callback: (event: ToolEvent) => Promise<void> | void) => {
        hooks.set(name, callback)
        return { dispose: async () => void hooks.delete(name) }
      },
    },
  }
  /** Calls the plugin's `execute.after` hook the way OpenCode does after a tool call, and returns the event. */
  const afterTool = async (tool: string, input: unknown, status: "completed" | "error" = "completed") => {
    const event: ToolEvent =
      status === "completed"
        ? { tool, input, status, result: { content: [{ type: "text", text: "Edited the file" }] } }
        : { tool, input, status, error: new Error("failed") }
    await hooks.get("execute.after")?.(event)
    return event
  }
  return { ctx, sent, done, afterTool }
}

type ToolEvent = { tool: string; input: unknown } & (
  | { status: "completed"; result: { content?: { type: string; text?: string }[] } }
  | { status: "error"; error: unknown }
)

describe("OpenCode plugin", () => {
  it("has a stable id", () => {
    expect(plugin.id).toBe("interlint")
  })

  it("runs the task-end checks in the project directory when an agent turn ends", async () => {
    const runs: string[] = []
    const { ctx, done } = fakeContext([{ type: "session.execution.succeeded", data: { sessionID: "s1" } }])

    await createInterlintPlugin(async (directory) => {
      runs.push(directory)
      return PASSED
    }).setup(ctx)
    await done

    expect(runs).toEqual(["/repo"])
  })

  it("resumes the session with the failures", async () => {
    const { ctx, sent, done } = fakeContext([{ type: "session.execution.succeeded", data: { sessionID: "s1" } }])

    await createInterlintPlugin(async () => VIOLATIONS).setup(ctx)
    await done
    await new Promise((resolve) => setImmediate(resolve))

    expect(sent).toEqual([
      { sessionID: "s1", text: expect.stringContaining("ARCH-01: rule"), resume: true },
    ])
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
