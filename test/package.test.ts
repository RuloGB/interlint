import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = join(import.meta.dirname, "..")

/** The files `npm pack` would put in the package. Reads `dist/` as it is, so build first. */
function packedFiles(): string[] {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: ROOT,
    encoding: "utf8",
    shell: process.platform === "win32",
  })
  if (result.status !== 0) throw new Error(`npm pack failed: ${result.stderr}`)
  const [pack] = JSON.parse(result.stdout) as [{ files: { path: string }[] }]
  return pack.files.map((file) => file.path).sort()
}

describe("the npm package", () => {
  const files = packedFiles()

  it("ships the CLI, the OpenCode plugin, the docs and the license", () => {
    expect(files).toEqual(
      expect.arrayContaining([
        "LICENSE",
        "README.md",
        "dist/cli.js",
        "docs/claude-code.md",
        "docs/opencode.md",
        "docs/usage.md",
        "integrations/opencode/interlint/index.ts",
        "package.json",
      ]),
    )
  })

  it("ships no tests, fixtures or internal files", () => {
    const allowed = /^(LICENSE|README\.md|package\.json|dist\/.+\.js|docs\/[\w-]+\.md|integrations\/opencode\/interlint\/[^/]+)$/
    expect(files.filter((path) => !allowed.test(path))).toEqual([])
  })

  it("declares the binary, the minimum Node version and the MIT license", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
    expect(manifest.bin).toEqual({ interlint: "dist/cli.js" })
    expect(manifest.engines).toEqual({ node: ">=22" })
    expect(manifest.license).toBe("MIT")
    expect(manifest.private).toBeUndefined()
  })
})
