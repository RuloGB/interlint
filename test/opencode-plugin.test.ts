import { describe, expect, it } from "vitest"
import plugin, {
  type CheckRun,
  createInterlintPlugin,
  MAX_CONSECUTIVE_BLOCKS,
  TaskEndGate,
} from "../adapters/opencode/interlint/index.js"

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

  it("reports a configuration error without making the agent continue", () => {
    expect(new TaskEndGate().decide("s1", { exitCode: 2, output: "interlint: interlint.yaml not found in /repo\n" })).toEqual({
      action: "report",
      text: "Interlint could not run the checks (exit code 2).\n\ninterlint: interlint.yaml not found in /repo\n",
    })
  })
})

/** A fake OpenCode V2 plugin context that records what the plugin sends to the session. */
function fakeContext(events: { type: string; data?: { sessionID?: string } }[]) {
  const sent: { sessionID: string; text: string; resume?: boolean }[] = []
  let finished!: () => void
  const done = new Promise<void>((resolve) => (finished = resolve))
  const ctx = {
    location: { directory: "/repo" },
    options: {},
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
  }
  return { ctx, sent, done }
}

describe("OpenCode plugin", () => {
  it("has a stable id", () => {
    expect(plugin.id).toBe("interlint")
  })

  it("runs the task-end checks in the project directory when a session goes idle", async () => {
    const runs: string[] = []
    const { ctx, done } = fakeContext([{ type: "session.idle", data: { sessionID: "s1" } }])

    await createInterlintPlugin(async (directory) => {
      runs.push(directory)
      return PASSED
    }).setup(ctx)
    await done

    expect(runs).toEqual(["/repo"])
  })

  it("resumes the session with the failures", async () => {
    const { ctx, sent, done } = fakeContext([{ type: "session.idle", data: { sessionID: "s1" } }])

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
