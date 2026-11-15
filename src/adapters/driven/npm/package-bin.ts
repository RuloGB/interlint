import { statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

/**
 * Whether npm installed a package's executable in a `node_modules/.bin` of `cwd` or of a directory above it, where
 * `npx` looks for it. On Windows npm writes a `.cmd` beside it.
 */
export function findsPackageBin(name: string, cwd: string): boolean {
  let dir = resolve(cwd)
  for (;;) {
    const bin = join(dir, "node_modules", ".bin", name)
    if (isFile(bin) || isFile(`${bin}.cmd`)) return true
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
