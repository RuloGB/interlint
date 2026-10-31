import { UserFacingError } from "../cli/cli-io.js"

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

export class HookInputError extends UserFacingError {}

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
