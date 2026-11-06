import { writtenLines } from "../../../domain/written-lines.js"
import { UserFacingError } from "../cli/cli-io.js"

/** The fields of a Claude Code hook's JSON input that Interlint reads. */
export interface HookInput {
  sessionId: string
  cwd?: string
  /** The file an `Edit` or `Write` call changed, as an absolute path. */
  filePath?: string
  /**
   * The lines the call wrote in that file: those an `Edit` adds or changes, every line of a `Write`. With
   * `replace_all`, an `Edit` counts as one replacement.
   */
  linesWritten: number
  /** Whether Claude Code is already continuing because a stop hook blocked. */
  stopHookActive: boolean
  /** The subagent the hook fires in. Claude Code leaves it out for the main agent. */
  agentId?: string
  /** The kind of that subagent, such as `Explore`. */
  agentType?: string
  /** The session's transcript, also in a subagent's hooks. */
  transcriptPath?: string
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
  const { session_id, cwd, tool_input, stop_hook_active, agent_id, agent_type, transcript_path } = value as Record<
    string,
    unknown
  >
  const toolInput = typeof tool_input === "object" && tool_input !== null ? (tool_input as Record<string, unknown>) : {}
  const { file_path: filePath } = toolInput
  return {
    sessionId: typeof session_id === "string" ? session_id : "",
    cwd: typeof cwd === "string" && cwd !== "" ? cwd : undefined,
    filePath: typeof filePath === "string" && filePath !== "" ? filePath : undefined,
    linesWritten: linesOf(toolInput),
    stopHookActive: stop_hook_active === true,
    agentId: nonEmpty(agent_id),
    agentType: nonEmpty(agent_type),
    transcriptPath: nonEmpty(transcript_path),
  }
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

/** The lines an `Edit` (`old_string`, `new_string`) or a `Write` (`content`) wrote. None for any other input. */
function linesOf({ old_string, new_string, content }: Record<string, unknown>): number {
  if (typeof new_string === "string") return writtenLines(typeof old_string === "string" ? old_string : "", new_string)
  return typeof content === "string" ? writtenLines("", content) : 0
}
