import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { hasExecutable } from "../src/adapters/process/executable-lookup.js"

let binDir: string

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "interlint-bin-"))
})

afterEach(() => {
  rmSync(binDir, { recursive: true, force: true })
})

describe("hasExecutable", () => {
  it("finds a Windows executable through PATHEXT", () => {
    writeFileSync(join(binDir, "mvnd.cmd"), "@echo off\n")

    expect(hasExecutable("mvnd", { PATH: binDir, PATHEXT: ".EXE;.CMD" }, "win32")).toBe(true)
  })

  it("ignores a Windows file without an executable extension, which cmd.exe cannot run", () => {
    writeFileSync(join(binDir, "mvnd"), "#!/bin/sh\n")

    expect(hasExecutable("mvnd", { PATH: binDir, PATHEXT: ".EXE;.CMD" }, "win32")).toBe(false)
  })

  it.skipIf(process.platform === "win32")("finds a POSIX file only when it is executable", () => {
    const file = join(binDir, "mvnd")
    writeFileSync(file, "#!/bin/sh\n")
    expect(hasExecutable("mvnd", { PATH: binDir }, "linux")).toBe(false)

    chmodSync(file, 0o755)
    expect(hasExecutable("mvnd", { PATH: binDir }, "linux")).toBe(true)
  })

  it("is false when the PATH does not have it", () => {
    expect(hasExecutable("mvnd", { PATH: binDir, PATHEXT: ".EXE;.CMD" }, "win32")).toBe(false)
    expect(hasExecutable("mvnd", {}, "linux")).toBe(false)
  })
})
