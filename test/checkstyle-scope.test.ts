import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { checkstyleOnFiles } from "../src/adapters/maven/checkstyle-scope.js"

/** What every limited command ends with: the resources are left out, so the report holds only the files. */
const ONLY_FILES = "-Dcheckstyle.includeResources=false -Dcheckstyle.includeTestResources=false"

let projectDir: string

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "interlint-scope-"))
})

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true })
})

function writeFile(path: string, content: string) {
  mkdirSync(dirname(join(projectDir, path)), { recursive: true })
  writeFileSync(join(projectDir, path), content)
}

describe("checkstyleOnFiles", () => {
  it("limits checkstyle:check to the files, with their paths from the source root, and leaves resources out", () => {
    expect(
      checkstyleOnFiles(
        "./mvnw -q checkstyle:check@style",
        ["app/src/main/java/shop/Order.java", "src/test/java/shop/OrderTest.java"],
        projectDir,
      ),
    ).toBe(`./mvnw -q checkstyle:check@style -Dcheckstyle.includes=shop/Order.java,shop/OrderTest.java ${ONLY_FILES}`)
  })

  it("names a file outside src/main/java or src/test/java by its name in any directory", () => {
    expect(checkstyleOnFiles("mvn checkstyle:check", ["source/shop/Order.java"], projectDir)).toBe(
      `mvn checkstyle:check -Dcheckstyle.includes=**/Order.java ${ONLY_FILES}`,
    )
  })

  it("leaves a command that does not run checkstyle:check as it is", () => {
    const pmd = "./mvnw -q compile pmd:check@rules -Dcheckstyle.skip"

    expect(checkstyleOnFiles(pmd, ["src/main/java/shop/Order.java"], projectDir)).toBe(pmd)
  })

  it("leaves a command that already sets checkstyle.includes as the team wrote it, quoted or not", () => {
    for (const command of ["mvn checkstyle:check -Dcheckstyle.includes=**/*.java", `mvn checkstyle:check "-Dcheckstyle.includes=a/**"`]) {
      expect(checkstyleOnFiles(command, ["src/main/java/shop/Order.java"], projectDir)).toBe(command)
    }
  })

  it("leaves the command as it is when the project sets checkstyle.includes, so edit checks what the build checks", () => {
    const command = "mvn checkstyle:check"
    writeFile("orders/pom.xml", "<project><properties><checkstyle.includes>keep/**/*.java</checkstyle.includes></properties></project>")

    expect(checkstyleOnFiles(command, ["src/main/java/shop/Order.java"], projectDir)).toBe(command)
  })

  it("leaves the command as it is when .mvn/maven.config sets checkstyle.includes", () => {
    const command = "mvn checkstyle:check"
    writeFile(".mvn/maven.config", "-Dcheckstyle.includes=keep/**/*.java\n")

    expect(checkstyleOnFiles(command, ["src/main/java/shop/Order.java"], projectDir)).toBe(command)
  })

  it("leaves a command with shell operators as it is: the property would reach the wrong program", () => {
    for (const command of ["mvn checkstyle:check && echo ok", "mvn checkstyle:check | tee log", "mvn checkstyle:check > log"]) {
      expect(checkstyleOnFiles(command, ["src/main/java/shop/Order.java"], projectDir)).toBe(command)
    }
  })

  it("leaves the command as it is when a path could mean something to the shell or is not plain ASCII", () => {
    const command = "mvn checkstyle:check"

    expect(checkstyleOnFiles(command, ["src/main/java/shop/Order;rm -rf.java"], projectDir)).toBe(command)
    expect(checkstyleOnFiles(command, ["src/main/java/my shop/Order.java"], projectDir)).toBe(command)
    expect(checkstyleOnFiles(command, ["src/main/java/ñandú/Pedido.java"], projectDir)).toBe(command)
  })
})
