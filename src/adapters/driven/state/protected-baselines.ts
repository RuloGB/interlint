import { createHash } from "node:crypto"
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import type { ProtectedBaselines } from "../../../application/checking/ports.js"
import type { Fingerprint } from "../../../domain/protected-files.js"
import { projectKey, userStateDir, writeWhole } from "./user-state.js"

/** A session nobody resumed for this long leaves its fingerprint behind no more. */
const BASELINE_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * One JSON file per project and session, written whole, under the user's state directory, in `interlint/<kind>`. The
 * resume baselines (F26) use the same format under another kind.
 */
export function fileProtectedBaselines(stateDir: () => string = userStateDir, kind = "protected"): ProtectedBaselines {
  const fileOf = (projectDir: string, session: string) => {
    // Hashed, because the session ID comes from the hook input and goes into a path.
    const name = createHash("sha256").update(`${projectKey(projectDir)}\0${session}`).digest("hex").slice(0, 32)
    return join(stateDir(), "interlint", kind, `${name}.json`)
  }
  return {
    read(projectDir, session) {
      try {
        const value: unknown = JSON.parse(readFileSync(fileOf(projectDir, session), "utf8"))
        return isFingerprint(value) ? value : undefined
      } catch {
        return undefined
      }
    },
    save(projectDir, session, fingerprint) {
      const file = fileOf(projectDir, session)
      if (writeWhole(file, JSON.stringify(fingerprint))) forgetStale(dirname(file))
    },
  }
}

function isFingerprint(value: unknown): value is Fingerprint {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((hash) => typeof hash === "string")
  )
}

function forgetStale(dir: string) {
  const now = Date.now()
  try {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      try {
        if (now - statSync(path).mtimeMs > BASELINE_TTL_MS) rmSync(path, { force: true })
      } catch {
        // Removed by another hook meanwhile.
      }
    }
  } catch {
    // The fingerprint was saved; only the cleanup is lost.
  }
}
