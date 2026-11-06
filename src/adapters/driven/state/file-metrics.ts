import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import type { MetricsSink } from "../../../application/checking/ports.js"
import { projectKey, userStateDir } from "./user-state.js"

/** The version of the line format. A reader of older lines tells them apart by it. */
const FORMAT_VERSION = 1

/**
 * Keeps metrics as JSON Lines, one line per check, in `<stateDir>/<projectKey>/<YYYY-MM>.jsonl`: one file per project
 * and per month (UTC), only ever appended to and never removed (decision 39). Plain text: they are the user's data on
 * the user's machine (decision 32). A line keeps the project's folder name, not its path, which may name a client
 * (decision 40). Any error loses the metrics and throws nothing.
 */
export function fileMetrics(stateDir?: string, now: () => Date = () => new Date()): MetricsSink {
  return (projectDir, metrics) => {
    if (metrics.length === 0) return
    try {
      const at = now().toISOString()
      const key = projectKey(projectDir)
      const envelope = { v: FORMAT_VERSION, at, interlint: interlintVersion(), projectKey: key, project: basename(resolve(projectDir)) }
      const dir = join(stateDir ?? join(userStateDir(), "interlint", "metrics"), key)
      // Only the user may read the metrics.
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      // One write for the whole run, made under the project lock, so two runs never mix their lines.
      const lines = metrics.map((metric) => `${JSON.stringify({ ...envelope, ...metric })}\n`).join("")
      appendFileSync(join(dir, `${at.slice(0, 7)}.jsonl`), lines)
    } catch {
      // Lost on purpose: a metric never changes what the checks give.
    }
  }
}

let version: string | undefined

/** Interlint's version, from its `package.json`: four levels up from this file in `src/` and in `dist/`. */
function interlintVersion(): string {
  if (version === undefined) {
    try {
      version = String(JSON.parse(readFileSync(new URL("../../../../package.json", import.meta.url), "utf8")).version)
    } catch {
      version = "unknown"
    }
  }
  return version
}
