import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { lockFileFor, withProjectLock } from "../src/adapters/driven/state/project-lock.js"

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

  it("lets only one waiter at a time take over a stale lock", async () => {
    const { pid } = spawnSync(process.execPath, ["-e", ""])
    holdLock(pid ?? 999_999)
    let running = 0
    let overlapped = false
    const work = async () => {
      running++
      if (running > 1) overlapped = true
      await sleep(50)
      running--
    }

    await Promise.all(Array.from({ length: 6 }, () => withProjectLock(projectDir, work)))

    expect(overlapped).toBe(false)
  })

  it("does not delete a lock that another process took over meanwhile", async () => {
    await withProjectLock(projectDir, async () => {
      writeFileSync(lockFileFor(projectDir), `${process.pid}:someone-else`)
    })

    expect(readFileSync(lockFileFor(projectDir), "utf8")).toBe(`${process.pid}:someone-else`)
  })

  it("never leaves an empty lock file while it takes the lock", async () => {
    let seenEmpty = false
    const watcher = setInterval(() => {
      try {
        if (readFileSync(lockFileFor(projectDir), "utf8") === "") seenEmpty = true
      } catch {
        // Not there yet.
      }
    }, 0)

    for (let round = 0; round < 50; round++) await withProjectLock(projectDir, async () => undefined)
    clearInterval(watcher)

    expect(seenEmpty).toBe(false)
  })

  it("keeps its locks in a directory of the current user", () => {
    expect(basename(dirname(lockFileFor(projectDir)))).toMatch(/^interlint-locks-.+/)
  })

  it("uses the same lock for two spellings of the same directory", () => {
    expect(lockFileFor(join(projectDir, "src", ".."))).toBe(lockFileFor(projectDir))
  })
})
