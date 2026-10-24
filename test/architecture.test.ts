import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const CORE_DIR = join(import.meta.dirname, "..", "src", "core")

/** `import … from "x"` and `export … from "x"`, type-only and multi-line ones included. */
const FROM_CLAUSE =
  /^\s*(?:import|export)\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\}|\w+(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+))?)\s+from\s*["']([^"']+)["']/gm
/** `import "x"`, which runs a module for its side effects. */
const BARE = /^\s*import\s*["']([^"']+)["']/gm
/** `import("x")`. A computed specifier is kept as written, so it never passes as a core module. */
const DYNAMIC = /\bimport\s*\(\s*(?:["']([^"']+)["']|([^)]*))\)/g

function importsOf(source: string): string[] {
  return [FROM_CLAUSE, BARE, DYNAMIC].flatMap((pattern) =>
    [...source.matchAll(pattern)].map((match) => match[1] ?? match[2] ?? ""),
  )
}

describe("importsOf", () => {
  it("finds every kind of import, and nothing that only looks like one", () => {
    const source = [
      `import { a } from "./a.js"`,
      `import type { B } from "./b.js"`,
      `import {`,
      `  c,`,
      `  d,`,
      `} from "./cd.js"`,
      `import e, { f } from "./ef.js"`,
      `import * as g from "./g.js"`,
      `export { h } from "./h.js"`,
      `export * from "./i.js"`,
      `import "./side-effect.js"`,
      `const j = await import("./j.js")`,
      `const k = await import(name)`,
      `export const REPORTS = ["archunit"] as const`,
      `export function load(from: string) { return "from" }`,
    ].join("\n")

    expect(importsOf(source).sort()).toEqual(
      ["./a.js", "./b.js", "./cd.js", "./ef.js", "./g.js", "./h.js", "./i.js", "./side-effect.js", "./j.js", "name"].sort(),
    )
  })
})

describe("core", () => {
  const files = readdirSync(CORE_DIR).filter((name) => name.endsWith(".ts"))

  it.each(files)("%s imports only other core modules", (file) => {
    const source = readFileSync(join(CORE_DIR, file), "utf8")
    expect(importsOf(source).filter((specifier) => !specifier.startsWith("./"))).toEqual([])
  })
})
