import { basename, dirname, join } from "node:path"
import type { TranscriptModel } from "../../../application/feedback/ports.js"
import { lastModelIn } from "./transcript-tail.js"

/** The model Claude Code puts on the answers it writes itself, such as an interrupted turn. */
const SYNTHETIC = "<synthetic>"

/**
 * The model of the last answer in a Claude Code transcript, read from its end in blocks so a long session costs no
 * more than a short one (decision 33). A subagent's model is in its own transcript,
 * `<session>/subagents/agent-<id>.jsonl` next to the session's, since its hooks give the session's transcript.
 * The format is not a public contract: whatever cannot be read gives no model (decision 36).
 */
export const transcriptModel: TranscriptModel = ({ path, agentId }) => {
  const file = agentId === undefined ? path : join(dirname(path), basename(path, ".jsonl"), "subagents", `agent-${agentId}.jsonl`)
  return lastModelIn(file, modelOf)
}

/** The model of an answer line, if it is one. A line still being written, or any other line, gives none. */
function modelOf(line: string): string | undefined {
  if (!line.includes('"assistant"')) return undefined
  try {
    const entry = JSON.parse(line) as { type?: unknown; message?: { model?: unknown } }
    const model = entry.type === "assistant" ? entry.message?.model : undefined
    return typeof model === "string" && model !== "" && model !== SYNTHETIC ? model : undefined
  } catch {
    return undefined
  }
}
