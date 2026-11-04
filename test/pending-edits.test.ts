import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { filePendingEdits } from "../src/adapters/driven/state/pending-edits.js"

let projectDir: string
let stateDir: string

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "interlint-pending-"))
  stateDir = mkdtempSync(join(tmpdir(), "interlint-pending-state-"))
})

afterEach(() => {
  for (const dir of [projectDir, stateDir]) rmSync(dir, { recursive: true, force: true })
})

describe("filePendingEdits", () => {
  it("has no pending files for a check it never saved", () => {
    expect(filePendingEdits(stateDir).list(projectDir, "pmd")).toEqual([])
  })

  it("keeps the files across instances, as across the processes of two edits", () => {
    expect(filePendingEdits(stateDir).save(projectDir, "pmd", [{ file: "src/A.java", lines: 12 }, { file: "src/B.java", lines: 0 }])).toBe(true)

    expect(filePendingEdits(stateDir).list(projectDir, "pmd")).toEqual([{ file: "src/A.java", lines: 12 }, { file: "src/B.java", lines: 0 }])
  })

  it("keeps the files of each check and each project apart", () => {
    const other = mkdtempSync(join(tmpdir(), "interlint-pending-other-"))
    try {
      const pending = filePendingEdits(stateDir)
      pending.save(projectDir, "pmd", [{ file: "src/A.java", lines: 1 }])
      pending.save(projectDir, "architecture", [{ file: "src/B.java", lines: 1 }])
      pending.save(other, "pmd", [{ file: "src/C.java", lines: 1 }])

      expect(pending.list(projectDir, "pmd")).toEqual([{ file: "src/A.java", lines: 1 }])
      expect(pending.list(projectDir, "architecture")).toEqual([{ file: "src/B.java", lines: 1 }])
      expect(pending.list(other, "pmd")).toEqual([{ file: "src/C.java", lines: 1 }])
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it("empties the files when saved with none", () => {
    const pending = filePendingEdits(stateDir)
    pending.save(projectDir, "pmd", [{ file: "src/A.java", lines: 1 }])
    pending.save(projectDir, "pmd", [])

    expect(pending.list(projectDir, "pmd")).toEqual([])
  })

  it("reads a record of an earlier version, a list of paths, as files that wrote no lines", () => {
    const pending = filePendingEdits(stateDir)
    pending.save(projectDir, "pmd", [{ file: "src/A.java", lines: 1 }])
    const [record] = readdirSync(stateDir)
    writeFileSync(join(stateDir, record!), JSON.stringify(["src/A.java", "src/B.java"]))

    expect(pending.list(projectDir, "pmd")).toEqual([
      { file: "src/A.java", lines: 0 },
      { file: "src/B.java", lines: 0 },
    ])
  })

  it("has no pending files when the record is not a list of pending edits", () => {
    const pending = filePendingEdits(stateDir)
    pending.save(projectDir, "pmd", [{ file: "src/A.java", lines: 1 }])
    const [record] = readdirSync(stateDir)
    writeFileSync(join(stateDir, record!), "{not json")
    expect(pending.list(projectDir, "pmd")).toEqual([])

    writeFileSync(join(stateDir, record!), JSON.stringify([{ file: "src/A.java", lines: "many" }]))
    expect(pending.list(projectDir, "pmd")).toEqual([])
  })

  it("says the files cannot be read when the record exists but is not readable", () => {
    const pending = filePendingEdits(stateDir)
    pending.save(projectDir, "pmd", [{ file: "src/A.java", lines: 1 }])
    const [record] = readdirSync(stateDir)
    rmSync(join(stateDir, record!))
    mkdirSync(join(stateDir, record!))

    expect(pending.list(projectDir, "pmd")).toBeUndefined()
  })

  it("says the files were not saved when the state directory cannot be written", () => {
    const blocked = join(stateDir, "blocked")
    writeFileSync(blocked, "a file, not a directory")

    expect(filePendingEdits(blocked).save(projectDir, "pmd", [{ file: "src/A.java", lines: 1 }])).toBe(false)
  })
})
