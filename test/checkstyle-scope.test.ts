import { describe, expect, it } from "vitest"
import { checkstyleOnFiles } from "../src/adapters/maven/checkstyle-scope.js"

describe("checkstyleOnFiles", () => {
  it("limits checkstyle:check to the files, with their paths from the source root", () => {
    expect(
      checkstyleOnFiles("./mvnw -q checkstyle:check@style", [
        "app/src/main/java/shop/Order.java",
        "src/test/java/shop/OrderTest.java",
      ]),
    ).toBe("./mvnw -q checkstyle:check@style -Dcheckstyle.includes=shop/Order.java,shop/OrderTest.java")
  })

  it("names a file outside src/main/java or src/test/java by its name in any directory", () => {
    expect(checkstyleOnFiles("mvn checkstyle:check", ["source/shop/Order.java"])).toBe(
      "mvn checkstyle:check -Dcheckstyle.includes=**/Order.java",
    )
  })

  it("leaves a command that does not run checkstyle:check as it is", () => {
    const pmd = "./mvnw -q compile pmd:check@rules -Dcheckstyle.skip"

    expect(checkstyleOnFiles(pmd, ["src/main/java/shop/Order.java"])).toBe(pmd)
  })

  it("leaves a command that already sets checkstyle.includes as the team wrote it", () => {
    const command = "mvn checkstyle:check -Dcheckstyle.includes=**/*.java"

    expect(checkstyleOnFiles(command, ["src/main/java/shop/Order.java"])).toBe(command)
  })

  it("leaves the command as it is when a path could mean something to the shell", () => {
    const command = "mvn checkstyle:check"

    expect(checkstyleOnFiles(command, ["src/main/java/shop/Order;rm -rf.java"])).toBe(command)
    expect(checkstyleOnFiles(command, ["src/main/java/my shop/Order.java"])).toBe(command)
  })
})
