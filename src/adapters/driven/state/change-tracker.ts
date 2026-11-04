import { createHash, randomUUID } from "node:crypto"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import type { ChangeTracker } from "../../../application/checking/ports.js"
import { projectKey, userStateDir, writeWhole } from "./user-state.js"

/** Directories a build or a package manager rewrites on its own. A change there is not the agent's. */
const IGNORED_DIRS = new Set(["target", "node_modules"])
/** What a project's record holds after an edit touched it, instead of the fingerprint of its files. */
const TOUCHED = "touched"

/**
 * Remembers, in a file per project under `stateDir`, the fingerprint of the project's files when its checks last
 * passed, or that an edit touched it since. It lives in the user's state directory, never in the project.
 * When the record cannot be written, the project counts as changed, so its checks still run.
 * Without `stateDir`, the user's state directory is looked up on each call, not once when the tracker is made.
 */
export function fileChangeTracker(stateDir?: string): ChangeTracker {
  const recordOf = (projectDir: string) =>
    join(stateDir ?? join(userStateDir(), "interlint", "projects"), projectKey(projectDir))
  return {
    lookup(projectDir) {
      const { fingerprint: current, lastModifiedMs } = scan(projectDir)
      const record = read(recordOf(projectDir))
      if (record === undefined) {
        return { changed: !writeWhole(recordOf(projectDir), current), record: current, fingerprint: current, lastModifiedMs }
      }
      return { changed: record.startsWith(TOUCHED) || record !== current, record, fingerprint: current, lastModifiedMs }
    },
    // The files as the checks saw them, not as they are after: a change made while the checks ran, by any
    // means, keeps the project changed. A check that writes outside build output only makes the next run repeat.
    accept(projectDir, seen) {
      if (read(recordOf(projectDir)) === seen.record) writeWhole(recordOf(projectDir), seen.fingerprint)
    },
    // Each touch is unique, so `accept` can tell a touch made while the checks ran from the one before them.
    touch(projectDir) {
      writeWhole(recordOf(projectDir), `${TOUCHED} ${randomUUID()}`)
    },
  }
}

/**
 * A hash of the path, size and modification time of every file of the project, outside build output, Node
 * dependencies and hidden directories such as `.git`. Any change to the files, through an edit tool or a shell
 * command, changes it; a commit does not, since it leaves the files as they are.
 */
export function fingerprint(projectDir: string): string {
  return scan(projectDir).fingerprint
}

/**
 * The fingerprint of the project's files, and the latest modification time among them and their directories:
 * removing a file changes no file left, only its directory. A directory that holds build output or Node
 * dependencies is left out, since a build changes its time when it creates or cleans them.
 */
function scan(projectDir: string): { fingerprint: string; lastModifiedMs: number } {
  const hash = createHash("sha256")
  const dirs: string[] = []
  let lastModifiedMs = 0
  for (const file of filesOf(projectDir, dirs)) {
    try {
      const { size, mtimeMs } = statSync(file)
      hash.update(`${relative(projectDir, file).split(sep).join("/")}\0${size}\0${mtimeMs}\n`)
      lastModifiedMs = Math.max(lastModifiedMs, mtimeMs)
    } catch {
      // Removed while walking: it is gone from the next fingerprint too.
    }
  }
  for (const dir of dirs) {
    try {
      lastModifiedMs = Math.max(lastModifiedMs, statSync(dir).mtimeMs)
    } catch {
      // Removed while walking, like a file.
    }
  }
  return { fingerprint: hash.digest("hex"), lastModifiedMs }
}

/**
 * The files below `dir`, in a stable order. Symbolic links are not followed. The directories walked that hold no
 * build output or Node dependencies, `dir` included, are added to `dirs`.
 */
function filesOf(dir: string, dirs: string[]): string[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  if (!entries.some((entry) => entry.isDirectory() && IGNORED_DIRS.has(entry.name))) dirs.push(dir)
  return entries
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((entry) => {
      const path = join(dir, entry.name)
      if (entry.isFile()) return [path]
      if (!entry.isDirectory() || entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) return []
      return filesOf(path, dirs)
    })
}

function read(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

