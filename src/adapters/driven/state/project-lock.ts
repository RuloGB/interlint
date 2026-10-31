import { randomUUID } from "node:crypto"
import { linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import type { ProjectLock } from "../../../application/checking/ports.js"
import { projectKey } from "./user-state.js"

const POLL_MS = 100
/** A lock this old is stale even if its PID is alive again: the OS may have reused the PID. */
const STALE_AFTER_MS = 30 * 60 * 1000
/** Removing a stale lock takes microseconds, so a takeover guard this old was left by a process that died. */
const TAKEOVER_STALE_AFTER_MS = 10 * 1000

/**
 * The lock file of a project. It lives in a temp directory of the current user, not in the project,
 * so it never shows up in the repo and other users on the same host cannot block or break it.
 * Every Interlint process of this user for the same project directory uses the same file.
 */
export function lockFileFor(projectDir: string): string {
  return join(tmpdir(), `interlint-locks-${currentUser()}`, `${projectKey(projectDir)}.lock`)
}

/** Runs `work` while holding the project lock, waiting for any other Interlint process that holds it. */
export const withProjectLock: ProjectLock = async (projectDir, work) => {
  const file = lockFileFor(projectDir)
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 })
  // The PID says whether the holder is alive; the random part tells this holder from a later one with the same PID.
  const token = `${process.pid}:${randomUUID()}`
  while (!tryAcquire(file, token)) {
    removeIfStale(file)
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  try {
    return await work()
  } finally {
    if (read(file) === token) rmSync(file, { force: true })
  }
}

/**
 * Creates the lock with its token already inside. The token goes to a private file first, and a hard link
 * publishes it, so no waiter ever sees an empty lock and mistakes it for one whose holder died.
 */
function tryAcquire(file: string, token: string): boolean {
  const draft = `${file}.${randomUUID()}.draft`
  writeFileSync(draft, token)
  try {
    linkSync(draft, file)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
    throw error
  } finally {
    rmSync(draft, { force: true })
  }
}

/** Removes the lock when its holder died without releasing it, for example when a timeout killed it. */
function removeIfStale(file: string) {
  const holder = read(file)
  if (holder === undefined || !isStale(file, holder)) return

  // One waiter at a time removes a stale lock. While the stale lock exists nobody can take a new one,
  // so the guard's owner deletes it only if it still holds the same token.
  const guard = `${file}.takeover`
  if (!tryAcquire(guard, holder)) {
    if (ageMs(guard) > TAKEOVER_STALE_AFTER_MS) rmSync(guard, { force: true })
    return
  }
  try {
    if (read(file) === holder) rmSync(file, { force: true })
  } finally {
    rmSync(guard, { force: true })
  }
}

function isStale(file: string, holder: string): boolean {
  return !isAlive(Number(holder.split(":")[0])) || ageMs(file) > STALE_AFTER_MS
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

function read(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

function ageMs(file: string): number {
  try {
    return Date.now() - statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/** A name for the current user that is safe in a file name. */
function currentUser(): string {
  try {
    const { uid, username } = userInfo()
    return uid >= 0 ? String(uid) : username.replace(/[^\w.-]/g, "_")
  } catch {
    return "default"
  }
}
