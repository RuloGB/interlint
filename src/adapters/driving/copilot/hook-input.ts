import { writtenLines } from "../../../domain/written-lines.js"
import { UserFacingError } from "../cli/cli-io.js"

/** The fields of a GitHub Copilot hook's JSON input, in its camelCase format, that Interlint reads. */
export interface CopilotHookInput {
  /**
   * The session. Inside a subagent Copilot gives the subagent's ID as `sessionId` and the session as `parentAgentId`,
   * while its `subagentStop` gives the session in both: the session is read from `parentAgentId` whenever there is one,
   * so a subagent's edits and its stop share one key.
   */
  sessionId: string
  cwd?: string
  /** The files an edit tool changed, as it gives them (absolute in Copilot's own tools), each with the lines it wrote. */
  edits: FileEdit[]
  /** Whether Copilot is already continuing because a stop hook blocked. */
  stopHookActive: boolean
  /** The subagent the hook fires in. */
  agentId?: string
  /** The kind of that subagent, as Copilot names it. */
  agentType?: string
  /** The session's `events.jsonl`. */
  transcriptPath?: string
}

export interface FileEdit {
  path: string
  linesWritten: number
}

export class CopilotHookInputError extends UserFacingError {}

/** Copilot's tools that change files. `view`, `bash` and the others change none, or none Interlint can name. */
const EDIT_TOOLS = new Set(["edit", "create", "str_replace_editor", "apply_patch"])

export function parseCopilotHookInput(text: string): CopilotHookInput {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new CopilotHookInputError("the hook input on stdin is not JSON")
  }
  if (!isObject(value)) throw new CopilotHookInputError("the hook input on stdin is not a JSON object")
  const { sessionId, parentAgentId, cwd, toolName, toolArgs, stop_hook_active, agentId, agentType, agentName, transcriptPath } =
    value
  const session = nonEmpty(agentId) === undefined ? undefined : nonEmpty(parentAgentId)
  return {
    sessionId: session ?? (typeof sessionId === "string" ? sessionId : ""),
    cwd: nonEmpty(cwd),
    edits: typeof toolName === "string" && EDIT_TOOLS.has(toolName) ? editsOf(toolArgs) : [],
    stopHookActive: stop_hook_active === true,
    agentId: nonEmpty(agentId),
    agentType: nonEmpty(agentType) ?? nonEmpty(agentName),
    transcriptPath: nonEmpty(transcriptPath),
  }
}

/**
 * The files in a tool's arguments: `path` with `old_str` and `new_str` (`edit`, `str_replace_editor`) or `file_text`
 * (`create`), or the files a patch adds or updates (`apply_patch`). Copilot may give the arguments as a JSON string.
 */
function editsOf(toolArgs: unknown): FileEdit[] {
  const args = typeof toolArgs === "string" ? parsedOr(toolArgs) : toolArgs
  if (typeof args === "string") return patchEdits(args)
  if (!isObject(args)) return []
  const { path, old_str, new_str, file_text, input, patch } = args
  const patchText = typeof input === "string" ? input : patch
  if (typeof patchText === "string") return patchEdits(patchText)
  if (typeof path !== "string" || path === "") return []
  if (typeof new_str === "string") return [{ path, linesWritten: writtenLines(typeof old_str === "string" ? old_str : "", new_str) }]
  return [{ path, linesWritten: typeof file_text === "string" ? writtenLines("", file_text) : 0 }]
}

const PATCH_FILE = /^\*\*\* (?:Add File|Update File|Move to): (.+)$/

/** The files a patch in the `*** Begin Patch` format adds or updates, each with the `+` lines it writes there. */
function patchEdits(patch: string): FileEdit[] {
  const edits: FileEdit[] = []
  for (const line of patch.split(/\r?\n/)) {
    const file = PATCH_FILE.exec(line)?.[1]?.trim()
    if (file !== undefined && file !== "") {
      const moved = line.startsWith("*** Move to:") ? edits.pop() : undefined
      edits.push({ path: file, linesWritten: moved?.linesWritten ?? 0 })
      continue
    }
    if (line.startsWith("*** ")) continue
    const current = edits.at(-1)
    if (current !== undefined && line.startsWith("+")) current.linesWritten++
  }
  return edits
}

function parsedOr(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
