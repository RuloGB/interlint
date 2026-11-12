import type { TranscriptModel } from "../../../application/feedback/ports.js"
import { lastModelIn } from "./claude-code-transcript.js"

/**
 * The model of the last answer in a GitHub Copilot session's `events.jsonl`: its `assistant.message` events carry it in
 * `data.model`. A subagent gets none, since the file does not say which answers are its own. The format is not a
 * public contract: whatever cannot be read gives no model (decision 36).
 */
export const copilotTranscriptModel: TranscriptModel = ({ path, agentId }) =>
  agentId === undefined ? lastModelIn(path, modelOf) : undefined

function modelOf(line: string): string | undefined {
  if (!line.includes('"assistant.message"')) return undefined
  try {
    const event = JSON.parse(line) as { type?: unknown; data?: { model?: unknown } }
    const model = event.type === "assistant.message" ? event.data?.model : undefined
    return typeof model === "string" && model !== "" ? model : undefined
  } catch {
    return undefined
  }
}
