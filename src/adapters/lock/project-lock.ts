import { createHash } from "node:crypto"
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { ProjectLock } from "../../core/ports.js"

const POLL_MS = 100
/** A lock this old is stale even if its PID is alive again: the OS may have reused the PID. */
const STALE_AFTER_MS = 30 * 60 * 1000

/**
 * The lock file of a project. It lives in the temp directory, not in the project, so it never shows up in the repo.
 * Every Interlint process for the same project directory uses the same file.
 */
export function lockFileFor(projectDir: string): string {
  let dir = resolve(projectDir)
  try {
    dir = realpathSync.native(dir)
  } catch {
    // Keep the resolved path when the directory does not exist.
  }
  if (process.platform === "win32") dir = dir.toLowerCase()
  const key = createHash("sha256").update(dir).digest("hex").slice(0, 16)
  return join(tmpdir(), "interlint-locks", `${key}.lock`)
}

/** Runs `work` while holding the project lock, waiting for any other Interlint process that holds it. */
export const withProjectLock: ProjectLock = async (projectDir, work) => {
  const file = lockFileFor(projectDir)
  mkdirSync(join(file, ".."), { recursive: true })
  while (!tryAcquire(file)) {
    removeIfStale(file)
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  try {
    return await work()
  } finally {
    rmSync(file, { force: true })
  }
}

function tryAcquire(file: string): boolean {
  try {
    const fd = openSync(file, "wx")
    writeSync(fd, String(process.pid))
    closeSync(fd)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
    throw error
  }
}

/** Removes the lock when its holder died without releasing it, for example when a timeout killed it. */
function removeIfStale(file: string) {
  let holder: string
  let modifiedMs: number
  try {
    holder = readFileSync(file, "utf8")
    modifiedMs = statSync(file).mtimeMs
  } catch {
    return // Released meanwhile.
  }
  if (isAlive(Number(holder)) && Date.now() - modifiedMs < STALE_AFTER_MS) return

  // Rename first, so two waiters that both saw the stale lock cannot delete a fresh one taken in between.
  const moved = `${file}.${process.pid}.stale`
  try {
    renameSync(file, moved)
  } catch {
    return // Another waiter got there first.
  }
  try {
    // Another waiter replaced the stale lock between the read and the rename: put its lock back.
    if (readFileSync(moved, "utf8") !== holder) renameSync(moved, file)
  } finally {
    rmSync(moved, { force: true })
  }
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}
