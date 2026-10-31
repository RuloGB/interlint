import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { AgentFiles } from "../../../application/setup/ports.js"

/**
 * The plugin as shipped with Interlint. `src/` and `dist/` are both one level below the package root, and this file
 * three levels below them.
 */
const PLUGIN_SOURCE = join(import.meta.dirname, "..", "..", "..", "..", "integrations", "opencode", "interlint")
/** OpenCode V2 loads plugins under this directory by itself, so `opencode.json(c)` stays untouched. */
const PLUGIN_TARGET = ".opencode/plugins/interlint"

/** The plugin files to copy into the project. They are Interlint's own, so an outdated copy is replaced. */
export const openCodePluginFiles: AgentFiles = () =>
  readdirSync(PLUGIN_SOURCE).map((name) => ({
    path: `${PLUGIN_TARGET}/${name}`,
    content: readFileSync(join(PLUGIN_SOURCE, name), "utf8"),
    replace: true,
  }))
