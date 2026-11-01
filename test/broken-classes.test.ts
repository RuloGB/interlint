import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { removeBrokenClasses } from "../src/adapters/driven/maven/broken-classes.js"

/** A class file's bytes around a constant, as the Eclipse compiler writes it for a method it could not compile. */
function classFile(constant: string): Buffer {
  return Buffer.concat([Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 65]), Buffer.from(constant, "utf8"), Buffer.from([0, 1])])
}

const BROKEN = classFile("Unresolved compilation problem: \n\tCustomerData cannot be resolved to a type\n")
const SOUND = classFile("Lcom/acme/domain/CustomerData;")

describe("removeBrokenClasses", () => {
  let project: string

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "interlint-broken-"))
    writeFileSync(join(project, "pom.xml"), "<project/>")
  })

  afterEach(() => {
    rmSync(project, { recursive: true, force: true })
  })

  function write(path: string, bytes: Buffer) {
    const file = join(project, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, bytes)
    return file
  }

  it("deletes the classes compiled with errors, in main and test classes, and returns their paths", () => {
    const main = write("target/classes/com/acme/domain/Customer.class", BROKEN)
    const test = write("target/test-classes/com/acme/CustomerTest.class", BROKEN)
    const sound = write("target/classes/com/acme/domain/CustomerData.class", SOUND)

    const removed = removeBrokenClasses(project)

    expect(removed.sort()).toEqual([main, test].sort())
    expect(existsSync(main)).toBe(false)
    expect(existsSync(test)).toBe(false)
    expect(existsSync(sound)).toBe(true)
  })

  it("looks in the modules of the project too", () => {
    write("orders/pom.xml", Buffer.from("<project/>"))
    const inModule = write("orders/target/classes/com/acme/Order.class", BROKEN)

    expect(removeBrokenClasses(project)).toEqual([inModule])
    expect(existsSync(inModule)).toBe(false)
  })

  it("leaves files that are not classes, and a project without target/", () => {
    expect(removeBrokenClasses(project)).toEqual([])
    const resource = write("target/classes/messages.properties", BROKEN)

    expect(removeBrokenClasses(project)).toEqual([])
    expect(existsSync(resource)).toBe(true)
  })
})
