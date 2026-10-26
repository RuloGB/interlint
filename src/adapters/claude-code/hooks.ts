import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { userStateDir } from "../state/user-state.js"

/** Exit codes as Claude Code reads them: 2 blocks and sends stderr to Claude, any other non-zero code is only shown to the user. */
export const HOOK_EXIT = { pass: 0, error: 1, block: 2 } as const

/** The same limit as the OpenCode plugin. */
export const MAX_CONSECUTIVE_BLOCKS = 3

/** The fields of a Claude Code hook's JSON input that Interlint reads. */
export interface HookInput {
  sessionId: string
  cwd?: string
  /** The file an `Edit` or `Write` call changed, as an absolute path. */
  filePath?: string
  /** Whether Claude Code is already continuing because a stop hook blocked. */
  stopHookActive: boolean
  /** The subagent the hook fires in. Claude Code leaves it out for the main agent. */
  agentId?: string
}

export class HookInputError extends Error {}

export function parseHookInput(text: string): HookInput {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new HookInputError("the hook input on stdin is not JSON")
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HookInputError("the hook input on stdin is not a JSON object")
  }
  const { session_id, cwd, tool_input, stop_hook_active, agent_id } = value as Record<string, unknown>
  const filePath =
    typeof tool_input === "object" && tool_input !== null ? (tool_input as { file_path?: unknown }).file_path : undefined
  return {
    sessionId: typeof session_id === "string" ? session_id : "",
    cwd: typeof cwd === "string" && cwd !== "" ? cwd : undefined,
    filePath: typeof filePath === "string" && filePath !== "" ? filePath : undefined,
    stopHookActive: stop_hook_active === true,
    agentId: typeof agent_id === "string" && agent_id !== "" ? agent_id : undefined,
  }
}

/**
 * Remembers the files a subagent changed, relative to the project, so its stop checks the projects that hold them.
 * Each hook run is its own process, so they are kept in a file per session and subagent.
 */
export function recordSubagentFiles(input: HookInput, files: string[]) {
  if (input.agentId === undefined || files.length === 0) return
  const file = stateFile("claude-code-subagents", input)
  const known = subagentFiles(input)
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(file, JSON.stringify([...new Set([...known, ...files])]))
  } catch {
    // The main agent's stop still checks every changed project.
  }
}

/** The files the subagent changed since its checks last passed: none for the main agent or a read-only subagent. */
export function subagentFiles(input: HookInput): string[] {
  if (input.agentId === undefined) return []
  try {
    const files: unknown = JSON.parse(readFileSync(stateFile("claude-code-subagents", input), "utf8"))
    return Array.isArray(files) ? files.filter((file): file is string => typeof file === "string") : []
  } catch {
    return []
  }
}

/** Forgets the subagent's files: its checks passed, or the main agent answers for them now. */
export function forgetSubagentFiles(input: HookInput) {
  if (input.agentId !== undefined) rmSync(stateFile("claude-code-subagents", input), { force: true })
}

/** What the post-edit hook sends to Claude when the checks fail. */
export function editNote(report: string): string {
  return `Interlint: the checks fail after this edit.\n\n${report}`
}

export type StopDecision = { action: "end" } | { action: "block"; text: string } | { action: "report"; text: string }

/**
 * Decides what the stop hook does with the task-end report, empty when every check passed.
 * Each hook run is its own process, so the blocks in a row are counted in a file per session, and per subagent
 * for a subagent's stop.
 * A stop that Claude Code did not reach by continuing after a stop hook starts a new count.
 * Past the limit the count stays, so stops in the same row (another stop hook may keep
 * Claude going) end quietly instead of blocking again.
 */
export function decideStop(input: HookInput, report: string): StopDecision {
  const file = stateFile("claude-code-stop", input)
  if (report === "") {
    rmSync(file, { force: true })
    return { action: "end" }
  }

  const attempt = (input.stopHookActive ? readBlockCount(file) : 0) + 1
  saveBlockCount(file, attempt)
  if (attempt === MAX_CONSECUTIVE_BLOCKS + 1) {
    return {
      action: "report",
      text: `Interlint: the checks still fail after ${MAX_CONSECUTIVE_BLOCKS} attempts, so the task may end.\n\n${report}`,
    }
  }
  if (attempt > MAX_CONSECUTIVE_BLOCKS) return { action: "end" }
  return {
    action: "block",
    text: `Interlint: the task cannot end yet (attempt ${attempt} of ${MAX_CONSECUTIVE_BLOCKS}).\n\n${report}`,
  }
}

function saveBlockCount(file: string, count: number) {
  try {
    // Only the user may read or change the count.
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(file, String(count))
  } catch {
    // Still decide: Claude Code ends the turn by itself after 8 stop-hook continuations in a row.
  }
}

/** A state file of the session, or of one of its subagents. */
function stateFile(kind: "claude-code-stop" | "claude-code-subagents", { sessionId, agentId }: HookInput): string {
  // Hashed, because the IDs come from the hook input and go into a path. The main agent keeps its old name.
  const key = agentId === undefined ? sessionId : `${sessionId}\0${agentId}`
  const name = createHash("sha256").update(key).digest("hex").slice(0, 32)
  return join(userStateDir(), "interlint", kind, name)
}

function readBlockCount(file: string): number {
  try {
    const count = Number.parseInt(readFileSync(file, "utf8"), 10)
    return Number.isInteger(count) && count > 0 ? count : 0
  } catch {
    return 0
  }
}
