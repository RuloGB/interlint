import { closeSync, fstatSync, openSync, readSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import type { TranscriptModel } from "../../../application/feedback/ports.js"

const BLOCK_BYTES = 64 * 1024
/** How far back the model is looked for: past it, the answers are too old to say which model answers now. */
const MAX_BYTES = 8 * 1024 * 1024
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
  let fd: number | undefined
  try {
    fd = openSync(file, "r")
    return lastModel(fd, fstatSync(fd).size)
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function lastModel(fd: number, size: number): string | undefined {
  let end = size
  // The pieces, in file order, of the line that starts before the block read, kept until its start is read. Joined
  // only then, so a line longer than many blocks is neither searched nor copied again on each one.
  let rest: Buffer[] = []
  while (end > 0 && size - end < MAX_BYTES) {
    const start = Math.max(0, end - BLOCK_BYTES)
    const block = Buffer.alloc(end - start)
    readSync(fd, block, 0, block.length, start)
    // Split on the newline byte, so a character split between two blocks is decoded whole.
    let lineEnd = block.length
    for (let at = block.length - 1; at >= 0; at--) {
      if (block[at] !== 0x0a) continue
      const model = modelOf(Buffer.concat([block.subarray(at + 1, lineEnd), ...rest]).toString("utf8"))
      if (model !== undefined) return model
      rest = []
      lineEnd = at
    }
    rest.unshift(block.subarray(0, lineEnd))
    if (start === 0) return modelOf(Buffer.concat(rest).toString("utf8"))
    end = start
  }
  return undefined
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
