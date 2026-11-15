import { statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import type { NpxToolLookup } from "../../../application/diagnosis/diagnose.js"

/**
 * Whether npx finds the tool installed in a `node_modules` of `cwd` or of a directory above it: its executable in
 * `.bin`, with the `.cmd` npm writes beside it on Windows, or its package, whose executable may have another name.
 */
export const findsNpxTool: NpxToolLookup = (tool, cwd) => {
  let dir = resolve(cwd)
  for (;;) {
    const modules = join(dir, "node_modules")
    const bin = join(modules, ".bin", tool.bin)
    if (isFile(bin) || isFile(`${bin}.cmd`)) return true
    if (tool.package !== undefined && isFile(join(modules, ...tool.package.split("/"), "package.json"))) return true
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
