import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  mavenQualityReader,
  parseCheckstyleXml,
  parsePmdXml,
  parseSpotBugsXml,
  readFreshQualityReports,
  readQualityReports,
  snapshotQualityReports,
} from "../src/adapters/driven/maven/reports/quality-reader.js"

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
        type: "checkstyle",
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
        type: "checkstyle",
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

  it("reads a report with as many errors as a large legacy codebase can have", () => {
    const errors = Array.from({ length: 150_000 }, (_, index) =>
      checkstyleError(index + 1, "error", "sizes.LineLengthCheck", "Too long."),
    )

    const [failure, ...others] = parseCheckstyleXml(checkstyleXml({ [ORDER]: errors }), PROJECT)

    expect(others).toEqual([])
    expect(failure?.title).toBe("LineLength")
    expect(failure?.violations).toHaveLength(150_000)
  }, 60_000)
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
        type: "pmd",
        violations: [
          { text: "Avoid empty catch blocks", file: "Order.java", line: 11, path: "src/main/java/shop/Order.java" },
          { text: "Avoid empty catch blocks", file: "Customer.java", line: 20, path: "src/main/java/shop/Customer.java" },
        ],
      },
      {
        title: "UnconditionalIfStatement",
        type: "pmd",
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
        type: "checkstyle",
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
        type: "pmd",
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

  it("reads the reports of modules at any depth, and of modules below a directory without pom.xml", () => {
    write("a/pom.xml", "<project/>")
    write("a/b/pom.xml", "<project/>")
    write("a/b/c/pom.xml", "<project/>")
    write("a/b/c/d/pom.xml", "<project/>")
    write("group/e/pom.xml", "<project/>")
    const before = snapshotQualityReports(projectDir)
    for (const module of ["a/b/c/d", "group/e"]) {
      write(
        `${module}/target/checkstyle-result.xml`,
        checkstyleXml({ [source(`${module}/src/main/java/shop/Order.java`)]: [checkstyleError(8, "error", "sizes.LineLengthCheck", "Too long.")] }),
      )
    }

    expect(readQualityReports(projectDir, before, BOTH_FAILED).failures[0]?.violations.map((violation) => violation.path)).toEqual([
      "a/b/c/d/src/main/java/shop/Order.java",
      "group/e/src/main/java/shop/Order.java",
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

describe("readFreshQualityReports", () => {
  /** In milliseconds, as the change tracker gives it. Reports are dated in seconds, as `utimesSync` takes them. */
  const SINCE_MS = 1_000_000
  const AFTER = 2000
  const PMD = "./mvnw -q compile pmd:check"
  let projectDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "interlint-fresh-maven-"))
    writeFileSync(join(projectDir, "pom.xml"), "<project/>")
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  function report(path: string, xml: string, writtenAt = AFTER) {
    const file = join(projectDir, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, xml)
    utimesSync(file, writtenAt, writtenAt)
  }

  const order = () => join(projectDir, "src", "main", "java", "shop", "Order.java")

  it("passes when the report of the goal the command runs, written after the project's last change, lists nothing", () => {
    report("target/pmd.xml", pmdXml({}))

    expect(readFreshQualityReports(projectDir, PMD, SINCE_MS)).toEqual({ found: true, failures: [] })
  })

  it("gives every finding as a failure, even one the build may accept, since it has no exit code to tell", () => {
    report("target/pmd.xml", pmdXml({ [order()]: [pmdViolation(4, 5, "UnusedLocalVariable", "Avoid unused local variables")] }))

    expect(readFreshQualityReports(projectDir, PMD, SINCE_MS)?.failures).toEqual([
      {
        title: "UnusedLocalVariable",
        type: "pmd",
        violations: [{ text: "Avoid unused local variables", file: "Order.java", line: 4, path: "src/main/java/shop/Order.java" }],
      },
    ])
  })

  it("ignores the report of a goal the command does not run", () => {
    report("target/pmd.xml", pmdXml({}))
    report(
      "target/checkstyle-result.xml",
      checkstyleXml({ [order()]: [checkstyleError(8, "error", "sizes.LineLengthCheck", "Too long.")] }),
      SINCE_MS / 1000,
    )

    expect(readFreshQualityReports(projectDir, PMD, SINCE_MS)).toEqual({ found: true, failures: [] })
  })

  it("reads nothing when that report is missing or was written before the project's last change", () => {
    expect(readFreshQualityReports(projectDir, PMD, SINCE_MS)).toBeUndefined()

    report("target/pmd.xml", pmdXml({}), SINCE_MS / 1000)
    expect(readFreshQualityReports(projectDir, PMD, SINCE_MS)).toBeUndefined()
  })

  it("reads nothing when that report was cut short", () => {
    report("target/pmd.xml", pmdXml({}).slice(0, 60))

    expect(readFreshQualityReports(projectDir, PMD, SINCE_MS)).toBeUndefined()
  })

  it("reads nothing when the command runs no check goal", () => {
    report("target/pmd.xml", pmdXml({}))

    expect(readFreshQualityReports(projectDir, "./mvnw -q verify", SINCE_MS)).toBeUndefined()
  })

  it("reads each goal's report when the command runs both, as checkstyle:check@id names an execution", () => {
    report("target/pmd.xml", pmdXml({}))

    expect(readFreshQualityReports(projectDir, "./mvnw -q checkstyle:check@style pmd:check", SINCE_MS)).toBeUndefined()

    report("target/checkstyle-result.xml", checkstyleXml({}))
    expect(readFreshQualityReports(projectDir, "./mvnw -q checkstyle:check@style pmd:check", SINCE_MS)).toEqual({
      found: true,
      failures: [],
    })
  })
})

/** A SpotBugs report as `spotbugs-maven-plugin` writes it: source dirs in `<Project>`, then one `<BugInstance>` per bug. */
function spotbugsXml(srcDirs: string[], bugs: string[]) {
  const dirs = srcDirs.map((dir) => `<SrcDir>${dir}</SrcDir>`).join("")
  return `<?xml version="1.0" encoding="utf-8"?>
<BugCollection sequence='0' release='' version='4.9.8'><Project projectName='shop'><Jar>target/classes</Jar>${dirs}</Project>${bugs.join("")}<Errors missingClasses='0' errors='0'></Errors><FindBugsSummary total_bugs='${bugs.length}'></FindBugsSummary><ClassFeatures></ClassFeatures><History></History></BugCollection>`
}

/** A bug with the class's source lines, the method's and the bug's own line, as SpotBugs nests them. */
function spotbugsBug(line: number, priority: number, type: string, message: string, sourcepath = "shop/Order.java") {
  const file = sourcepath.split("/").at(-1)
  const at = (start: number, end: number, primary = "") =>
    `<SourceLine classname='shop.Order' start='${start}' end='${end}' sourcepath='${sourcepath}' sourcefile='${file}'${primary}><Message>At ${file}</Message></SourceLine>`
  return `<BugInstance rank='12' abbrev='SEC' category='SECURITY' priority='${priority}' type='${type}'><ShortMessage>Short</ShortMessage><LongMessage>${message}</LongMessage><Class classname='shop.Order' primary='true'>${at(1, 40)}<Message>In class shop.Order</Message></Class><Method classname='shop.Order' name='run' primary='true'>${at(line - 1, line + 1)}</Method>${at(line, line, " primary='true'")}</BugInstance>`
}

/** The line Maven prints when SpotBugs' `check` goal fails. */
const SPOTBUGS_FAILED =
  "[ERROR] Failed to execute goal com.github.spotbugs:spotbugs-maven-plugin:4.9.8.3:check (spotbugs) on project shop: failed with 2 bugs and 0 errors -> [Help 1]"

describe("parseSpotBugsXml", () => {
  const srcDir = join(PROJECT, "src", "main", "java")

  it("returns one failure per bug type with its message and file:line, resolved from the report's source dirs", () => {
    const xml = spotbugsXml(
      [srcDir],
      [
        spotbugsBug(19, 2, "COMMAND_INJECTION", "This usage of Runtime.exec(String) can be vulnerable to Command Injection"),
        spotbugsBug(11, 2, "PREDICTABLE_RANDOM", "This random generator (java.util.Random) is predictable"),
        spotbugsBug(7, 2, "COMMAND_INJECTION", "This usage of ProcessBuilder can be vulnerable to Command Injection", "shop/Customer.java"),
      ],
    )

    expect(parseSpotBugsXml(xml, PROJECT)).toEqual([
      {
        title: "COMMAND_INJECTION",
        type: "spotbugs",
        violations: [
          {
            text: "This usage of Runtime.exec(String) can be vulnerable to Command Injection",
            file: "Order.java",
            line: 19,
            path: "src/main/java/shop/Order.java",
          },
          {
            text: "This usage of ProcessBuilder can be vulnerable to Command Injection",
            file: "Customer.java",
            line: 7,
            path: "src/main/java/shop/Customer.java",
          },
        ],
      },
      {
        title: "PREDICTABLE_RANDOM",
        type: "spotbugs",
        violations: [
          {
            text: "This random generator (java.util.Random) is predictable",
            file: "Order.java",
            line: 11,
            path: "src/main/java/shop/Order.java",
          },
        ],
      },
    ])
  })

  it("keeps only the most severe priority, so bugs under the build's failThreshold never show", () => {
    const xml = spotbugsXml(
      [srcDir],
      [
        spotbugsBug(5, 3, "DM_DEFAULT_ENCODING", "Found reliance on default encoding"),
        spotbugsBug(19, 1, "COMMAND_INJECTION", "Command Injection"),
        spotbugsBug(11, 2, "PREDICTABLE_RANDOM", "Predictable"),
      ],
    )

    expect(parseSpotBugsXml(xml, PROJECT).map((failure) => failure.title)).toEqual(["COMMAND_INJECTION"])
  })

  it("looks for the source in src/main/java when the report names no source dir", () => {
    const xml = spotbugsXml([], [spotbugsBug(19, 2, "COMMAND_INJECTION", "Command Injection")])

    expect(parseSpotBugsXml(xml, PROJECT)[0]?.violations).toEqual([
      { text: "Command Injection", file: "Order.java", line: 19, path: "src/main/java/shop/Order.java" },
    ])
  })

  it("places a bug without its own source line by its field's, method's or class's", () => {
    const sourceLine = (start: number) =>
      `<SourceLine classname='shop.Order' start='${start}' end='${start + 20}' sourcepath='shop/Order.java' sourcefile='Order.java'/>`
    const classLevel = `<BugInstance type='SE_BAD_FIELD' priority='2'><LongMessage>Non-serializable field</LongMessage><Class classname='shop.Order' primary='true'>${sourceLine(3)}</Class><Field classname='shop.Order' name='lock' primary='true'>${sourceLine(9)}</Field></BugInstance>`
    const onlyClass = `<BugInstance type='CN_IDIOM' priority='2'><LongMessage>Clone without super.clone</LongMessage><Class classname='shop.Order' primary='true'>${sourceLine(3)}</Class></BugInstance>`

    expect(parseSpotBugsXml(spotbugsXml([srcDir], [classLevel, onlyClass]), PROJECT).map((failure) => failure.violations)).toEqual([
      [{ text: "Non-serializable field", file: "Order.java", line: 9, path: "src/main/java/shop/Order.java" }],
      [{ text: "Clone without super.clone", file: "Order.java", line: 3, path: "src/main/java/shop/Order.java" }],
    ])
  })

  it("returns nothing for a report without bugs", () => {
    expect(parseSpotBugsXml(spotbugsXml([srcDir], []), PROJECT)).toEqual([])
  })
})

describe("readQualityReports with SpotBugs", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "interlint-spotbugs-"))
    writeFileSync(join(projectDir, "pom.xml"), "<project/>")
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  function write(path: string, content: string) {
    mkdirSync(dirname(join(projectDir, path)), { recursive: true })
    writeFileSync(join(projectDir, path), content)
  }

  /** Writes a module's source and returns the module's source dir, as the report lists it. */
  function sourceIn(module: string, file: string) {
    write(join(module, "src/main/java/shop", file), "class X {}")
    return join(projectDir, module, "src", "main", "java")
  }

  it("reads the reports of every module, with paths from the directory Interlint started in", () => {
    write("api/pom.xml", "<project/>")
    write("api/domain/pom.xml", "<project/>")
    const before = snapshotQualityReports(projectDir)
    const generated = join(projectDir, "api", "domain", "target", "generated-sources", "annotations")
    write(
      "api/domain/target/spotbugsXml.xml",
      spotbugsXml([sourceIn("api/domain", "Order.java"), generated], [spotbugsBug(19, 2, "COMMAND_INJECTION", "Command Injection")]),
    )

    expect(readQualityReports(projectDir, before, SPOTBUGS_FAILED).failures).toEqual([
      {
        title: "COMMAND_INJECTION",
        type: "spotbugs",
        violations: [{ text: "Command Injection", file: "Order.java", line: 19, path: "api/domain/src/main/java/shop/Order.java" }],
      },
    ])
  })

  it("looks for the source in the module of the report when it names no source dir", () => {
    write("api/pom.xml", "<project/>")
    const before = snapshotQualityReports(projectDir)
    write("api/target/spotbugsXml.xml", spotbugsXml([], [spotbugsBug(19, 2, "COMMAND_INJECTION", "Command Injection")]))

    expect(readQualityReports(projectDir, before, SPOTBUGS_FAILED).failures[0]?.violations[0]?.path).toBe(
      "api/src/main/java/shop/Order.java",
    )
  })

  it("resolves a source in the second source dir, such as a generated one", () => {
    const before = snapshotQualityReports(projectDir)
    write("target/generated-sources/annotations/shop/OrderMapperImpl.java", "class X {}")
    write(
      "target/spotbugsXml.xml",
      spotbugsXml(
        [join(projectDir, "src", "main", "java"), join(projectDir, "target", "generated-sources", "annotations")],
        [spotbugsBug(9, 2, "PREDICTABLE_RANDOM", "Predictable", "shop/OrderMapperImpl.java")],
      ),
    )

    expect(readQualityReports(projectDir, before, SPOTBUGS_FAILED).failures[0]?.violations[0]?.path).toBe(
      "target/generated-sources/annotations/shop/OrderMapperImpl.java",
    )
  })

  it("shows nothing from the report when Maven failed for another reason, such as a module that does not compile", () => {
    const before = snapshotQualityReports(projectDir)
    write("target/spotbugsXml.xml", spotbugsXml([sourceIn("", "Order.java")], [spotbugsBug(5, 2, "PREDICTABLE_RANDOM", "Predictable")]))
    const output =
      "[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.15.0:compile (default-compile) on project api: Compilation failure"

    expect(readQualityReports(projectDir, before, output)).toEqual({ found: true, failures: [] })
  })

  it("keeps SpotBugs' report out when only PMD's check failed", () => {
    const before = snapshotQualityReports(projectDir)
    write("target/spotbugsXml.xml", spotbugsXml([sourceIn("", "Order.java")], [spotbugsBug(5, 2, "PREDICTABLE_RANDOM", "Predictable")]))

    expect(readQualityReports(projectDir, before, failedGoal("pmd")).failures).toEqual([])
  })

  it("skips a report cut short, so Maven's output shows instead", () => {
    const before = snapshotQualityReports(projectDir)
    const full = spotbugsXml([sourceIn("", "Order.java")], [spotbugsBug(5, 2, "PREDICTABLE_RANDOM", "Predictable")])
    write("target/spotbugsXml.xml", full.slice(0, full.indexOf("<LongMessage>") + 20))

    expect(readQualityReports(projectDir, before, SPOTBUGS_FAILED)).toEqual({ found: true, failures: [] })
  })
})

describe("readFreshQualityReports with SpotBugs", () => {
  const SINCE_MS = 1_000_000
  const AFTER = 2000
  const SPOTBUGS = "./mvnw -q compile spotbugs:check@spotbugs -Dcheckstyle.skip -Dpmd.skip"
  let projectDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "interlint-fresh-spotbugs-"))
    writeFileSync(join(projectDir, "pom.xml"), "<project/>")
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  function report(xml: string, writtenAt = AFTER) {
    const file = join(projectDir, "target", "spotbugsXml.xml")
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, xml)
    utimesSync(file, writtenAt, writtenAt)
  }

  it("passes when the build the agent ran after its last change left a SpotBugs report without bugs", () => {
    report(spotbugsXml([], []))

    expect(readFreshQualityReports(projectDir, SPOTBUGS, SINCE_MS)).toEqual({ found: true, failures: [] })
  })

  it("gives every bug as a failure, since it has no exit code to tell what the build accepts", () => {
    report(spotbugsXml([], [spotbugsBug(5, 3, "DM_DEFAULT_ENCODING", "Found reliance on default encoding")]))

    expect(readFreshQualityReports(projectDir, SPOTBUGS, SINCE_MS)?.failures.map((failure) => failure.title)).toEqual([
      "DM_DEFAULT_ENCODING",
    ])
  })

  it("reads nothing when the report is older than the last change or cut short", () => {
    report(spotbugsXml([], []), SINCE_MS / 1000)
    expect(readFreshQualityReports(projectDir, SPOTBUGS, SINCE_MS)).toBeUndefined()

    report(spotbugsXml([], []).slice(0, 80))
    expect(readFreshQualityReports(projectDir, SPOTBUGS, SINCE_MS)).toBeUndefined()
  })
})
