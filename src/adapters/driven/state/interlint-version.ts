import { readFileSync } from "node:fs"

let version: string | undefined

/** Interlint's version, from its `package.json`: four levels up from this file in `src/` and in `dist/`. */
export function interlintVersion(): string {
  if (version === undefined) {
    try {
      version = String(JSON.parse(readFileSync(new URL("../../../../package.json", import.meta.url), "utf8")).version)
    } catch {
      version = "unknown"
    }
  }
  return version
}
