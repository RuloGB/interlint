/** A file an edit tool changed, as the agent gives its path, with the lines it wrote there. */
export interface FileEdit {
  path: string
  linesWritten: number
}

const PATCH_FILE = /^\*\*\* (?:Add File|Update File|Move to): (.+)$/

/**
 * The files a patch in the `*** Begin Patch` format of `apply_patch` adds or updates, each with the `+` lines it
 * writes there. A deleted file is left out: there is nothing left to check.
 */
export function patchEdits(patch: string): FileEdit[] {
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
