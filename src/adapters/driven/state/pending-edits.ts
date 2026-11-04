import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { PendingEdits } from "../../../application/checking/ports.js"
import { projectKey, userStateDir, writeWhole } from "./user-state.js"

/**
 * Keeps the pending files of each check, as a JSON list in a file per project and check under `stateDir`. It lives in
 * the user's state directory, never in the project. A record that cannot be read holds no files.
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
      try {
        const files: unknown = JSON.parse(readFileSync(recordOf(projectDir, check), "utf8"))
        return Array.isArray(files) && files.every((file) => typeof file === "string") ? files : []
      } catch {
        return []
      }
    },
    save(projectDir, check, files) {
      return writeWhole(recordOf(projectDir, check), JSON.stringify(files))
    },
  }
}
