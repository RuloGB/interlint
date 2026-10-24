import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { lockFileFor, withProjectLock } from "../src/adapters/lock/project-lock.js"

let projectDir: string

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "interlint-lock-"))
})

afterEach(() => {
  rmSync(lockFileFor(projectDir), { force: true })
  rmSync(projectDir, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function holdLock(pid: number) {
  mkdirSync(dirname(lockFileFor(projectDir)), { recursive: true })
  writeFileSync(lockFileFor(projectDir), String(pid))
}

describe("withProjectLock", () => {
  it("runs one piece of work at a time for the same project", async () => {
    const events: string[] = []
    const work = (id: string) => async () => {
      events.push(`start ${id}`)
      await sleep(150)
      events.push(`end ${id}`)
    }

    await Promise.all([withProjectLock(projectDir, work("a")), withProjectLock(projectDir, work("b"))])

    expect(events).toHaveLength(4)
    expect(events[1]).toBe(`end ${events[0]?.slice("start ".length)}`)
  })

  it("releases the lock when the work throws", async () => {
    await expect(withProjectLock(projectDir, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom")

    expect(await withProjectLock(projectDir, async () => "next")).toBe("next")
  })

  it("takes over a lock whose process is gone", async () => {
    const { pid } = spawnSync(process.execPath, ["-e", ""])
    holdLock(pid ?? 999_999)

    expect(await withProjectLock(projectDir, async () => "ran")).toBe("ran")
  })

  it("waits while the process holding the lock is alive", async () => {
    holdLock(process.pid)
    let ran = false
    const waiting = withProjectLock(projectDir, async () => {
      ran = true
    })

    await sleep(300)
    expect(ran).toBe(false)
    rmSync(lockFileFor(projectDir))
    await waiting
    expect(ran).toBe(true)
  })

  it("uses the same lock for two spellings of the same directory", () => {
    expect(lockFileFor(join(projectDir, "src", ".."))).toBe(lockFileFor(projectDir))
  })
})
