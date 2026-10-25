import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  mavenQualityReader,
  parseCheckstyleXml,
  parsePmdXml,
  readQualityReports,
  snapshotQualityReports,
} from "../src/adapters/maven/quality-reports.js"

const PROJECT = join(tmpdir(), "shop")
const ORDER = join(PROJECT, "src", "main", "java", "shop", "Order.java")
const CUSTOMER = join(PROJECT, "src", "main", "java", "shop", "Customer.java")

/** A Checkstyle report as `maven-checkstyle-plugin` writes it, one `<file>` per source. */
function checkstyleXml(files: Record<string, string[]>) {
  const body = Object.entries(files)
    .map(([name, errors]) => `<file name="${name}">\n${errors.join("\n")}\n</file>`)
    .join("\n")
  return `<?xml version="1.0" encoding="UTF-8"?>\n<checkstyle version="9.3">\n${body}\n</checkstyle>\n`
}

function checkstyleError(line: number, severity: string, check: string, message: string) {
  return `<error line="${line}" column="3" severity="${severity}" message="${message}" source="com.puppycrawl.tools.checkstyle.checks.${check}"/>`
}

/** A PMD report as `maven-pmd-plugin` writes it, one `<file>` per source. */
function pmdXml(files: Record<string, string[]>) {
  const body = Object.entries(files)
    .map(([name, violations]) => `<file name="${name}">\n${violations.join("\n")}\n</file>`)
    .join("\n")
  return `<?xml version="1.0" encoding="UTF-8"?>
<pmd xmlns="http://pmd.sourceforge.net/report/2.0.0" version="7.7.0" timestamp="2026-10-25T10:44:17.149">
${body}
</pmd>
`
}

/** The line Maven prints when a plugin goal fails, the same with or without -q. */
function failedGoal(plugin: "checkstyle" | "pmd") {
  const version = plugin === "checkstyle" ? "3.6.0" : "3.26.0"
  return `[ERROR] Failed to execute goal org.apache.maven.plugins:maven-${plugin}-plugin:${version}:check (default-cli) on project shop: violations found -> [Help 1]`
}

const BOTH_FAILED = [failedGoal("checkstyle"), failedGoal("pmd")].join("\n")

function pmdViolation(line: number, priority: number, rule: string, message: string) {
  return `<violation beginline="${line}" endline="${line}" begincolumn="7" endcolumn="6" rule="${rule}" ruleset="Error Prone" package="shop" class="Order" priority="${priority}">
${message}
</violation>`
}

describe("parseCheckstyleXml", () => {
  it("returns one failure per rule, named as Checkstyle prints it, with each message and file:line", () => {
    const xml = checkstyleXml({
      [ORDER]: [
        checkstyleError(8, "error", "sizes.LineLengthCheck", "Line is longer than 80 characters (found 87)."),
        checkstyleError(11, "error", "javadoc.JavadocVariableCheck", "Missing a Javadoc comment."),
      ],
      [CUSTOMER]: [checkstyleError(3, "error", "sizes.LineLengthCheck", "Line is longer than 80 characters (found 91).")],
    })

    expect(parseCheckstyleXml(xml, PROJECT)).toEqual([
      {
        title: "LineLength",
        violations: [
          {
            text: "Line is longer than 80 characters (found 87).",
            file: "Order.java",
            line: 8,
            path: "src/main/java/shop/Order.java",
          },
          {
            text: "Line is longer than 80 characters (found 91).",
            file: "Customer.java",
            line: 3,
            path: "src/main/java/shop/Customer.java",
          },
        ],
      },
      {
        title: "JavadocVariable",
        violations: [
          { text: "Missing a Javadoc comment.", file: "Order.java", line: 11, path: "src/main/java/shop/Order.java" },
        ],
      },
    ])
  })

  it("keeps only the most severe level, so warnings the build accepted never show", () => {
    const xml = checkstyleXml({
      [ORDER]: [
        checkstyleError(8, "warning", "javadoc.MissingJavadocMethodCheck", "Missing a Javadoc comment."),
        checkstyleError(9, "error", "sizes.LineLengthCheck", "Line is longer than 80 characters (found 87)."),
        checkstyleError(10, "info", "whitespace.WhitespaceAroundCheck", "'=' is not preceded with whitespace."),
      ],
    })

    expect(parseCheckstyleXml(xml, PROJECT).map((failure) => failure.title)).toEqual(["LineLength"])
  })

  it("shows the warnings when they are the most severe level", () => {
    const xml = checkstyleXml({
      [ORDER]: [checkstyleError(8, "warning", "javadoc.MissingJavadocMethodCheck", "Missing a Javadoc comment.")],
    })

    expect(parseCheckstyleXml(xml, PROJECT).map((failure) => failure.title)).toEqual(["MissingJavadocMethod"])
  })

  it("returns nothing for a report without errors", () => {
    expect(parseCheckstyleXml(checkstyleXml({ [ORDER]: [] }), PROJECT)).toEqual([])
    expect(parseCheckstyleXml(checkstyleXml({}), PROJECT)).toEqual([])
  })
})

describe("parsePmdXml", () => {
  it("returns one failure per rule with each message and file:line", () => {
    const xml = pmdXml({
      [ORDER]: [
        pmdViolation(11, 3, "EmptyCatchBlock", "Avoid empty catch blocks"),
        pmdViolation(13, 3, "UnconditionalIfStatement", "Do not use if statements that are always true or always false"),
      ],
      [CUSTOMER]: [pmdViolation(20, 3, "EmptyCatchBlock", "Avoid empty catch blocks")],
    })

    expect(parsePmdXml(xml, PROJECT)).toEqual([
      {
        title: "EmptyCatchBlock",
        violations: [
          { text: "Avoid empty catch blocks", file: "Order.java", line: 11, path: "src/main/java/shop/Order.java" },
          { text: "Avoid empty catch blocks", file: "Customer.java", line: 20, path: "src/main/java/shop/Customer.java" },
        ],
      },
      {
        title: "UnconditionalIfStatement",
        violations: [
          {
            text: "Do not use if statements that are always true or always false",
            file: "Order.java",
            line: 13,
            path: "src/main/java/shop/Order.java",
          },
        ],
      },
    ])
  })

  it("keeps only the most severe priority, so violations under the project's threshold never show", () => {
    const xml = pmdXml({
      [ORDER]: [
        pmdViolation(3, 4, "UnnecessaryImport", "Unused import 'java.util.List'"),
        pmdViolation(11, 2, "EmptyCatchBlock", "Avoid empty catch blocks"),
        pmdViolation(6, 3, "UnusedPrivateField", "Avoid unused private fields such as 'unused'."),
      ],
    })

    expect(parsePmdXml(xml, PROJECT).map((failure) => failure.title)).toEqual(["EmptyCatchBlock"])
  })

  it("returns nothing for a clean report", () => {
    expect(parsePmdXml(pmdXml({}), PROJECT)).toEqual([])
  })
})

describe("readQualityReports", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "interlint-maven-"))
    writeFileSync(join(projectDir, "pom.xml"), "<project/>")
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  function write(path: string, content: string) {
    mkdirSync(dirname(join(projectDir, path)), { recursive: true })
    writeFileSync(join(projectDir, path), content)
  }

  const source = (path: string) => join(projectDir, path)

  it("reads the Checkstyle and PMD reports written since the snapshot, and ignores older ones", () => {
    write(
      "target/pmd.xml",
      pmdXml({ [source("src/main/java/shop/Old.java")]: [pmdViolation(1, 3, "EmptyCatchBlock", "Avoid empty catch blocks")] }),
    )
    const before = snapshotQualityReports(projectDir)
    write(
      "target/checkstyle-result.xml",
      checkstyleXml({
        [source("src/main/java/shop/Order.java")]: [checkstyleError(8, "error", "sizes.LineLengthCheck", "Too long.")],
      }),
    )

    const result = readQualityReports(projectDir, before, BOTH_FAILED)

    expect(result.found).toBe(true)
    expect(result.failures).toEqual([
      {
        title: "LineLength",
        violations: [{ text: "Too long.", file: "Order.java", line: 8, path: "src/main/java/shop/Order.java" }],
      },
    ])
  })

  it("reads a report rewritten within the same timestamp tick", () => {
    const tick = new Date(Date.now() - 60_000)
    write("target/pmd.xml", pmdXml({}))
    utimesSync(join(projectDir, "target/pmd.xml"), tick, tick)
    const before = snapshotQualityReports(projectDir)
    write(
      "target/pmd.xml",
      pmdXml({ [source("src/main/java/shop/Order.java")]: [pmdViolation(11, 3, "EmptyCatchBlock", "Avoid empty catch blocks")] }),
    )
    utimesSync(join(projectDir, "target/pmd.xml"), tick, tick)

    expect(readQualityReports(projectDir, before, BOTH_FAILED).failures.map((failure) => failure.title)).toEqual(["EmptyCatchBlock"])
  })

  it("reads the reports of the project's modules", () => {
    write("api/pom.xml", "<project/>")
    write("api/domain/pom.xml", "<project/>")
    const before = snapshotQualityReports(projectDir)
    write(
      "api/domain/target/pmd.xml",
      pmdXml({
        [source("api/domain/src/main/java/shop/Order.java")]: [pmdViolation(11, 3, "EmptyCatchBlock", "Avoid empty catch blocks")],
      }),
    )

    expect(readQualityReports(projectDir, before, BOTH_FAILED).failures).toEqual([
      {
        title: "EmptyCatchBlock",
        violations: [
          {
            text: "Avoid empty catch blocks",
            file: "Order.java",
            line: 11,
            path: "api/domain/src/main/java/shop/Order.java",
          },
        ],
      },
    ])
  })

  it("says so when the run wrote no report", () => {
    expect(readQualityReports(projectDir, snapshotQualityReports(projectDir), BOTH_FAILED)).toEqual({ found: false, failures: [] })
  })

  it("shows only the reports of the plugins whose check failed, so accepted entries of the other one stay out", () => {
    const before = snapshotQualityReports(projectDir)
    write(
      "target/checkstyle-result.xml",
      checkstyleXml({
        [source("src/main/java/shop/Order.java")]: [checkstyleError(8, "warning", "javadoc.MissingJavadocMethodCheck", "Missing.")],
      }),
    )
    write(
      "target/pmd.xml",
      pmdXml({ [source("src/main/java/shop/Order.java")]: [pmdViolation(11, 3, "EmptyCatchBlock", "Avoid empty catch blocks")] }),
    )

    const result = readQualityReports(projectDir, before, `[INFO] BUILD FAILURE\n${failedGoal("pmd")}`)

    expect(result.failures.map((failure) => failure.title)).toEqual(["EmptyCatchBlock"])
  })

  it("recognises the failed goal when Maven colors its output", () => {
    const before = snapshotQualityReports(projectDir)
    write(
      "target/pmd.xml",
      pmdXml({ [source("src/main/java/shop/Order.java")]: [pmdViolation(11, 3, "EmptyCatchBlock", "Avoid empty catch blocks")] }),
    )
    const colored =
      "[\u001b[1;31mERROR\u001b[m] Failed to execute goal \u001b[32morg.apache.maven.plugins:maven-pmd-plugin:3.26.0:check\u001b[m \u001b[1m(default-cli)\u001b[m on project \u001b[36mshop\u001b[m"

    expect(readQualityReports(projectDir, before, colored).failures.map((failure) => failure.title)).toEqual([
      "EmptyCatchBlock",
    ])
  })

  it("shows nothing from the reports when Maven failed for another reason, such as a module that does not compile", () => {
    const before = snapshotQualityReports(projectDir)
    write(
      "target/pmd.xml",
      pmdXml({ [source("src/main/java/shop/Order.java")]: [pmdViolation(3, 4, "UnnecessaryImport", "Unused import")] }),
    )
    const output = "[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.15.0:compile (default-compile) on project api: Compilation failure"

    expect(readQualityReports(projectDir, before, output)).toEqual({ found: true, failures: [] })
  })

  it("skips a report cut short, as Checkstyle leaves it when a source cannot be parsed, so Maven's output shows instead", () => {
    const before = snapshotQualityReports(projectDir)
    const full = checkstyleXml({
      [source("src/main/java/shop/Order.java")]: [checkstyleError(8, "error", "sizes.LineLengthCheck", "Too long.")],
    })
    write("target/checkstyle-result.xml", full.slice(0, full.indexOf("source=") + 20))

    expect(readQualityReports(projectDir, before, failedGoal("checkstyle"))).toEqual({ found: true, failures: [] })
  })

  it("is the reader of a report that also lists what the build accepted", () => {
    expect(mavenQualityReader.alsoListsAccepted).toBe(true)
  })
})
