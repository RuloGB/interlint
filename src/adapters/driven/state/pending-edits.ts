import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { PendingEdit, PendingEdits } from "../../../application/checking/ports.js"
import { projectKey, userStateDir, writeWhole } from "./user-state.js"

/**
 * Keeps the pending files of each check, as a JSON list of `{ file, lines }` in a file per project and check under
 * `stateDir`. It lives in the user's state directory, never in the project. A list of paths, as earlier versions
 * saved it, holds files that wrote no lines; any other record holds no files.
 * Without `stateDir`, the user's state directory is looked up on each call, not once when it is made.
 */
export function filePendingEdits(stateDir?: string): PendingEdits {
  const recordOf = (projectDir: string, check: string) =>
    join(
      stateDir ?? join(userStateDir(), "interlint", "pending"),
      `${projectKey(projectDir)}-${createHash("sha256").update(check).digest("hex").slice(0, 16)}.json`,
    )
  return {
    list(projectDir, check) {
      let text: string
      try {
        text = readFileSync(recordOf(projectDir, check), "utf8")
      } catch (error) {
        // Missing, nothing was saved. Otherwise, such as a file an antivirus holds on Windows, it is unknown.
        return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : undefined
      }
      try {
        return parseRecord(JSON.parse(text))
      } catch {
        return []
      }
    },
    save(projectDir, check, edits) {
      return writeWhole(recordOf(projectDir, check), JSON.stringify(edits))
    },
  }
}

function parseRecord(record: unknown): PendingEdit[] {
  if (!Array.isArray(record)) return []
  const edits = record.map((entry: unknown) => (typeof entry === "string" ? { file: entry, lines: 0 } : entry))
  return edits.every(isPendingEdit) ? edits : []
}

function isPendingEdit(entry: unknown): entry is PendingEdit {
  if (typeof entry !== "object" || entry === null) return false
  const { file, lines } = entry as { file?: unknown; lines?: unknown }
  return typeof file === "string" && typeof lines === "number" && Number.isInteger(lines) && lines >= 0
}
