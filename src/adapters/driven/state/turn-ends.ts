import { readFileSync, rmSync } from "node:fs"
import { dirname } from "node:path"
import type { TurnEnd, TurnEnds } from "../../../application/checking/ports.js"
import { forgetStale, isFingerprint, sessionFile } from "./protected-baselines.js"
import { userStateDir, writeWhole } from "./user-state.js"

/** One JSON file per project and session, written whole, under the user's state directory, in `interlint/turn-end`. */
export function fileTurnEnds(stateDir: () => string = userStateDir): TurnEnds {
  const fileOf = (projectDir: string, session: string) => sessionFile(stateDir(), "turn-end", projectDir, session)
  return {
    read(projectDir, session) {
      try {
        const value: unknown = JSON.parse(readFileSync(fileOf(projectDir, session), "utf8"))
        return isTurnEnd(value) ? value : undefined
      } catch {
        return undefined
      }
    },
    save(projectDir, session, turnEnd) {
      const file = fileOf(projectDir, session)
      if (writeWhole(file, JSON.stringify(turnEnd))) forgetStale(dirname(file))
    },
    forget(projectDir, session) {
      try {
        rmSync(fileOf(projectDir, session), { force: true })
      } catch {
        // Rare, as `force` ignores a missing file; the next stop writes the record again.
      }
    },
  }
}

function isTurnEnd(value: unknown): value is TurnEnd {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const { projects, protected: kept } = value as Record<string, unknown>
  return isFingerprint(projects) && (kept === undefined || isFingerprint(kept))
}
