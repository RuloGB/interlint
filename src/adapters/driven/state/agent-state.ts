import { createHash } from "node:crypto"
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { AgentRef, StopCounter, SubagentFiles } from "../../../application/feedback/ports.js"
import { userStateDir } from "./user-state.js"

/** A subagent that never stopped, interrupted or in a session that ended, leaves its files this long at most. */
const SUBAGENT_RECORD_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Each hook run is its own process, so the files of a subagent are kept in a file per session and subagent, one per
 * line. The lines are appended, so the hooks of parallel edits never drop each other's files.
 */
export const fileSubagentFiles: SubagentFiles = {
  record(agent, files) {
    if (agent.agentId === undefined || files.length === 0) return
    const file = stateFile("claude-code-subagents", agent)
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      forgetStaleRecords(dirname(file))
      appendFileSync(file, files.map((path) => `${path}\n`).join(""))
    } catch {
      // The main agent's stop still checks every changed project.
    }
  },
  list(agent) {
    if (agent.agentId === undefined) return []
    try {
      const lines = readFileSync(stateFile("claude-code-subagents", agent), "utf8").split("\n")
      return [...new Set(lines.filter((line) => line !== ""))]
    } catch {
      return []
    }
  },
  forget(agent) {
    if (agent.agentId !== undefined) rmSync(stateFile("claude-code-subagents", agent), { force: true })
  },
}

function forgetStaleRecords(dir: string) {
  const now = Date.now()
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    try {
      if (now - statSync(path).mtimeMs > SUBAGENT_RECORD_TTL_MS) rmSync(path, { force: true })
    } catch {
      // Removed by another hook meanwhile.
    }
  }
}

/** Each hook run is its own process, so the blocks in a row are counted in a file per session and subagent. */
export const fileStopCounter: StopCounter = {
  read(agent) {
    try {
      const count = Number.parseInt(readFileSync(stateFile("claude-code-stop", agent), "utf8"), 10)
      return Number.isInteger(count) && count > 0 ? count : 0
    } catch {
      return 0
    }
  },
  save(agent, count) {
    const file = stateFile("claude-code-stop", agent)
    try {
      // Only the user may read or change the count.
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      writeFileSync(file, String(count))
    } catch {
      // Still decide: Claude Code ends the turn by itself after 8 stop-hook continuations in a row.
    }
  },
  clear(agent) {
    rmSync(stateFile("claude-code-stop", agent), { force: true })
  },
}

/** A state file of the session, or of one of its subagents. */
function stateFile(kind: "claude-code-stop" | "claude-code-subagents", { sessionId, agentId }: AgentRef): string {
  // Hashed, because the IDs come from the hook input and go into a path. The main agent keeps its old name.
  const key = agentId === undefined ? sessionId : `${sessionId}\0${agentId}`
  const name = createHash("sha256").update(key).digest("hex").slice(0, 32)
  return join(userStateDir(), "interlint", kind, name)
}
