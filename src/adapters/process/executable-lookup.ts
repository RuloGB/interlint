import { accessSync, constants, statSync } from "node:fs"
import { delimiter, join } from "node:path"
import type { ExecutableLookup } from "../../core/ports.js"

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD"

/** Whether a shell would find `name` on the PATH. On Windows only files with a PATHEXT extension count. */
export function hasExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter((dir) => dir !== "")
  const extensions = platform === "win32" ? (env.PATHEXT ?? DEFAULT_PATHEXT).split(";").filter(Boolean) : [""]
  return dirs.some((dir) => extensions.some((extension) => isExecutableFile(join(dir, name + extension), platform)))
}

export const lookupExecutable: ExecutableLookup = (name) => hasExecutable(name)

function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false
    if (platform !== "win32") accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}
