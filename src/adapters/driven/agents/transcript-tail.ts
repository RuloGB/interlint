import { closeSync, fstatSync, openSync, readSync } from "node:fs"

const BLOCK_BYTES = 64 * 1024
/** How far back the model is looked for: past it, the answers are too old to say which model answers now. */
const MAX_BYTES = 8 * 1024 * 1024

/**
 * The model of the last line of a JSON Lines file that `modelOf` reads one from, read from the file's end in blocks.
 * None when the file cannot be read or no line in its last 8 MB gives one.
 */
export function lastModelIn(file: string, modelOf: (line: string) => string | undefined): string | undefined {
  let fd: number | undefined
  try {
    fd = openSync(file, "r")
    return lastModel(fd, fstatSync(fd).size, modelOf)
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function lastModel(fd: number, size: number, modelOf: (line: string) => string | undefined): string | undefined {
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
