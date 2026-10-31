import { statSync } from "node:fs"
import type { DirectoryLookup } from "../../../application/checking/ports.js"

export const isDirectory: DirectoryLookup = (path) => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
