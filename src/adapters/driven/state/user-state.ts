import { createHash } from "node:crypto"
import { mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, posix, resolve, win32 } from "node:path"

/** Writes a record whole, through a temporary file, so a concurrent reader never sees half of it. */
export function writeWhole(file: string, content: string): boolean {
  try {
    // Only the user may read or change the records.
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const draft = `${file}.${process.pid}.draft`
    writeFileSync(draft, content)
    renameSync(draft, file)
    return true
  } catch {
    return false
  }
}

/**
 * The user's own directory for state that outlives a process. Not the system temp directory:
 * on a shared machine another user could create Interlint's directory there first.
 * A relative value is ignored, as the XDG spec asks: it would put the state in the hook's working directory.
 */
export function userStateDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  const windows = platform === "win32"
  const configured = windows ? env.LOCALAPPDATA : env.XDG_STATE_HOME
  if (configured && (windows ? win32 : posix).isAbsolute(configured)) return configured
  return windows ? join(homedir(), "AppData", "Local") : join(homedir(), ".local", "state")
}

/**
 * A short name for a project directory that is safe in a file name. Every spelling of the same directory gets
 * the same name: relative or absolute, through a symbolic link, and in any case on Windows.
 */
export function projectKey(projectDir: string): string {
  let dir = resolve(projectDir)
  try {
    dir = realpathSync.native(dir)
  } catch {
    // Keep the resolved path when the directory does not exist.
  }
  if (process.platform === "win32") dir = dir.toLowerCase()
  return createHash("sha256").update(dir).digest("hex").slice(0, 16)
}
