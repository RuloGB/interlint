import { writtenLines } from "../../../domain/written-lines.js"
import { UserFacingError } from "../cli/cli-io.js"
import { type FileEdit, patchEdits } from "../hooks/patch-edits.js"

/** The fields of a Codex hook's JSON input, in its snake_case format, that Interlint reads. */
export interface CodexHookInput {
  /** The session. A subagent's hooks give the session of the agent that started it. */
  sessionId: string
  /** The session's working directory, where Codex runs the hook. */
  cwd?: string
  /** The files an edit tool changed, as it gives them (absolute in Codex's own patches, or relative to `cwd`), each with the lines it wrote. */
  edits: FileEdit[]
  /** Whether Codex is already continuing because a stop hook blocked. */
  stopHookActive: boolean
  /** The subagent the hook fires in. */
  agentId?: string
  /** The kind of that subagent, as Codex names it. */
  agentType?: string
  /** The active model, which Codex gives in every hook. */
  model?: string
  /** The user's prompt, in a `UserPromptSubmit` hook. */
  prompt?: string
  /** Whether an `apply_patch` input held no patch Interlint can read, so no file could be named. */
  unreadablePatch: boolean
}

export class CodexHookInputError extends UserFacingError {}

/**
 * Codex's edit tool. Codex documents that the input names every edit `apply_patch`, even when the matcher says `Edit`
 * or `Write`; an `Edit` or `Write` input is still read, in Claude Code's format, in case a Codex version sends one.
 */
const PATCH_TOOL = "apply_patch"

export function parseCodexHookInput(text: string): CodexHookInput {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new CodexHookInputError("the hook input on stdin is not JSON")
  }
  if (!isObject(value)) throw new CodexHookInputError("the hook input on stdin is not a JSON object")
  const { session_id, cwd, tool_name, tool_input, stop_hook_active, agent_id, agent_type, model, prompt } = value
  const patch = tool_name === PATCH_TOOL ? patchOf(tool_input) : undefined
  return {
    sessionId: typeof session_id === "string" ? session_id : "",
    cwd: nonEmpty(cwd),
    edits: tool_name === PATCH_TOOL ? (patch === undefined ? [] : patchEdits(patch)) : editsOf(tool_name, tool_input),
    stopHookActive: stop_hook_active === true,
    agentId: nonEmpty(agent_id),
    agentType: nonEmpty(agent_type),
    model: nonEmpty(model),
    unreadablePatch: tool_name === PATCH_TOOL && patch === undefined,
    ...(typeof prompt === "string" ? { prompt } : {}),
  }
}

/** The patch text of an `apply_patch` input: `command` as documented, or `input` or `patch`, or the input itself. */
function patchOf(toolInput: unknown): string | undefined {
  if (typeof toolInput === "string") return toolInput
  if (!isObject(toolInput)) return undefined
  const patch = [toolInput.command, toolInput.input, toolInput.patch].find((field) => typeof field === "string")
  return typeof patch === "string" ? patch : undefined
}

/** The file of an `Edit` or `Write` input: `file_path`, with the lines of `new_string` or `content`. */
function editsOf(toolName: unknown, toolInput: unknown): FileEdit[] {
  if (toolName !== "Edit" && toolName !== "Write") return []
  if (!isObject(toolInput)) return []
  const { file_path, old_string, new_string, content } = toolInput
  if (typeof file_path !== "string" || file_path === "") return []
  if (typeof new_string === "string") {
    return [{ path: file_path, linesWritten: writtenLines(typeof old_string === "string" ? old_string : "", new_string) }]
  }
  return [{ path: file_path, linesWritten: typeof content === "string" ? writtenLines("", content) : 0 }]
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
