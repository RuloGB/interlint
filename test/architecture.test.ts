import { readdirSync, readFileSync } from "node:fs"
import { join, posix, sep } from "node:path"
import { describe, expect, it } from "vitest"

const SRC_DIR = join(import.meta.dirname, "..", "src")

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

/** Every source file, as a `/`-separated path relative to `src/`. */
function sourceFiles(): string[] {
  return readdirSync(SRC_DIR, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".ts"))
    .map((path) => path.split(sep).join("/"))
}

/**
 * The layer a source file belongs to: `domain`, `application`, `driving`, one `driven/<adapter>`, or `main`.
 * Driven adapters are told apart, so one never reaches into another.
 */
function layerOf(path: string): string {
  const [top, side, adapter] = path.split("/")
  if (top === "adapters") return side === "driven" ? `driven/${adapter}` : "driving"
  return top === "main.ts" ? "main" : (top ?? "")
}

/** The source files `file` imports, relative to `src/`. Packages and Node built-ins are left out. */
function importedFiles(file: string): string[] {
  const source = readFileSync(join(SRC_DIR, file), "utf8")
  return importsOf(source)
    .filter((specifier) => specifier.startsWith("."))
    .map((specifier) => posix.join(posix.dirname(file), specifier).replace(/\.js$/, ".ts"))
}

/** What each layer may import besides itself. A driven adapter also reaches its own files. */
const ALLOWED: Record<string, (layer: string) => boolean> = {
  domain: () => false,
  application: (layer) => layer === "domain",
  driving: (layer) => layer === "domain" || layer === "application",
  driven: (layer) => layer === "domain" || layer === "application",
  main: () => true,
}

describe("layers", () => {
  const files = sourceFiles()

  it("finds the source files of every layer", () => {
    expect(new Set(files.map((file) => layerOf(file).split("/")[0]))).toEqual(
      new Set(["domain", "application", "driving", "driven", "main"]),
    )
  })

  it.each(files)("%s imports only what its layer may", (file) => {
    const layer = layerOf(file)
    const allowed = ALLOWED[layer.split("/")[0] ?? ""] ?? (() => false)
    const forbidden = importedFiles(file).filter((imported) => {
      const target = layerOf(imported)
      return target !== layer && !allowed(target)
    })
    expect(forbidden).toEqual([])
  })

  it.each(files.filter((file) => ["domain", "application"].includes(layerOf(file))))(
    "%s imports no package or Node built-in",
    (file) => {
      const source = readFileSync(join(SRC_DIR, file), "utf8")
      expect(importsOf(source).filter((specifier) => !specifier.startsWith("."))).toEqual([])
    },
  )
})
