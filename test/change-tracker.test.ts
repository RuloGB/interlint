import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { fileChangeTracker } from "../src/adapters/state/change-tracker.js"

let projectDir: string
let stateDir: string

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "interlint-changes-"))
  stateDir = mkdtempSync(join(tmpdir(), "interlint-changes-state-"))
  write("pom.xml", "<project/>")
  write("domain/src/main/java/shop/Order.java", "class Order {}")
})

afterEach(() => {
  for (const dir of [projectDir, stateDir]) rmSync(dir, { recursive: true, force: true })
})

function write(path: string, content: string) {
  mkdirSync(dirname(join(projectDir, path)), { recursive: true })
  writeFileSync(join(projectDir, path), content)
}

describe("fileChangeTracker", () => {
  it("counts a project it sees for the first time as unchanged, so the first task end does not run every project", () => {
    expect(fileChangeTracker(stateDir).lookup(projectDir).changed).toBe(false)
  })

  it("counts a project as changed once one of its files is added, changed or removed after that", () => {
    const tracker = fileChangeTracker(stateDir)
    tracker.lookup(projectDir).changed
    write("domain/src/main/java/shop/Customer.java", "class Customer {}")
    expect(tracker.lookup(projectDir).changed).toBe(true)

    tracker.accept(projectDir, tracker.lookup(projectDir))
    write("domain/src/main/java/shop/Order.java", "class Order { int id; }")
    expect(tracker.lookup(projectDir).changed).toBe(true)

    tracker.accept(projectDir, tracker.lookup(projectDir))
    rmSync(join(projectDir, "domain/src/main/java/shop/Customer.java"))
    expect(tracker.lookup(projectDir).changed).toBe(true)
  })

  it("counts a file whose modification time changed, as an edit that keeps the size does", () => {
    const tracker = fileChangeTracker(stateDir)
    tracker.lookup(projectDir).changed
    const later = new Date(Date.now() + 60_000)
    utimesSync(join(projectDir, "pom.xml"), later, later)

    expect(tracker.lookup(projectDir).changed).toBe(true)
  })

  it("ignores build output, Node dependencies and hidden directories, which a build or an IDE rewrites", () => {
    const tracker = fileChangeTracker(stateDir)
    tracker.lookup(projectDir).changed
    write("domain/target/surefire-reports/TEST-A.xml", "<testsuite/>")
    write("target/classes/Order.class", "x")
    write("web/node_modules/left-pad/index.js", "x")
    write(".git/index", "x")
    write(".idea/workspace.xml", "x")

    expect(tracker.lookup(projectDir).changed).toBe(false)
  })

  it("stays unchanged after its checks pass until a file changes again", () => {
    const tracker = fileChangeTracker(stateDir)
    write("domain/src/main/java/shop/Customer.java", "class Customer {}")
    tracker.accept(projectDir, tracker.lookup(projectDir))

    expect(tracker.lookup(projectDir).changed).toBe(false)
    expect(fileChangeTracker(stateDir).lookup(projectDir).changed).toBe(false)
  })

  it("counts a project an edit touched as changed, even when its files look the same, until its checks pass", () => {
    const tracker = fileChangeTracker(stateDir)
    tracker.lookup(projectDir).changed
    tracker.touch(projectDir)

    expect(tracker.lookup(projectDir).changed).toBe(true)
    expect(tracker.lookup(projectDir).changed).toBe(true)
    tracker.accept(projectDir, tracker.lookup(projectDir))
    expect(tracker.lookup(projectDir).changed).toBe(false)
  })

  it("keeps a project changed when an edit touched it while its checks ran", () => {
    const tracker = fileChangeTracker(stateDir)
    tracker.touch(projectDir)
    const seen = tracker.lookup(projectDir)

    tracker.touch(projectDir)
    tracker.accept(projectDir, seen)

    expect(tracker.lookup(projectDir).changed).toBe(true)
  })

  it("keeps a project changed when a file changed while its checks ran, even without an edit", () => {
    const tracker = fileChangeTracker(stateDir)
    tracker.touch(projectDir)
    const seen = tracker.lookup(projectDir)

    // A shell command, an IDE or another session changes a file while the checks run.
    write("domain/src/main/java/shop/Customer.java", "class Customer {}")
    tracker.accept(projectDir, seen)

    expect(tracker.lookup(projectDir).changed).toBe(true)
  })

  it("keeps each project on its own", () => {
    const other = mkdtempSync(join(tmpdir(), "interlint-changes-other-"))
    try {
      const tracker = fileChangeTracker(stateDir)
      tracker.touch(projectDir)

      expect(tracker.lookup(other).changed).toBe(false)
      expect(tracker.lookup(projectDir).changed).toBe(true)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it("keeps its state in the state directory, never in the project", () => {
    const before = readdirSync(projectDir, { recursive: true }).sort()
    const tracker = fileChangeTracker(stateDir)
    tracker.touch(projectDir)
    tracker.accept(projectDir, tracker.lookup(projectDir))

    expect(readdirSync(projectDir, { recursive: true }).sort()).toEqual(before)
    expect(readdirSync(stateDir, { recursive: true })).not.toHaveLength(0)
  })

  it("counts a project as changed when it cannot keep its state, so its checks still run", () => {
    const blocked = join(stateDir, "file")
    writeFileSync(blocked, "not a directory")

    expect(fileChangeTracker(join(blocked, "projects")).lookup(projectDir).changed).toBe(true)
  })
})
