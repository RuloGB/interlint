import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/** Every process the code under test starts, with the options it passed. */
const spawned = vi.hoisted(() => [] as { command: string; options: { windowsHide?: boolean } }[])

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  const spawn = (...args: unknown[]) => {
    const options = args.find((arg) => typeof arg === "object" && arg !== null && !Array.isArray(arg))
    spawned.push({ command: String(args[0]), options: (options ?? {}) as { windowsHide?: boolean } })
    return (actual.spawn as (...spawnArgs: unknown[]) => ReturnType<typeof actual.spawn>)(...args)
  }
  return { ...actual, spawn }
})

const { runCommand } = await import("../src/adapters/process/command-runner.js")
const { runInterlint } = await import("../integrations/opencode/interlint/index.js")

let scratch: string

beforeEach(() => {
  spawned.length = 0
  scratch = mkdtempSync(join(tmpdir(), "interlint-hide-"))
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

// OpenCode Desktop runs without a console, so Windows opens a console window for every
// shell it starts unless the spawn asks to hide it.
describe("no console window on Windows", () => {
  it("the CLI hides the shell that runs a check", async () => {
    await runCommand("node -e 0", scratch)

    expect(spawned.map((entry) => entry.options.windowsHide)).toEqual([true])
  })

  it("the OpenCode plugin hides the shell that runs Interlint", async () => {
    await runInterlint(scratch, "node -e 0", 10_000)

    expect(spawned.map((entry) => entry.options.windowsHide)).toEqual([true])
  })

  it("the OpenCode plugin hides taskkill when a run times out", async () => {
    writeFileSync(join(scratch, "hang.mjs"), "setTimeout(() => {}, 60_000)\n")

    await runInterlint(scratch, "node hang.mjs", 300)

    const killers = spawned.filter((entry) => entry.command === "taskkill")
    if (process.platform === "win32") expect(killers.map((entry) => entry.options.windowsHide)).toEqual([true])
    else expect(killers).toEqual([])
  })
})
