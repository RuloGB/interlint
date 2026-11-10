import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { jacocoReader, readJacocoOutput } from "../src/adapters/driven/maven/reports/jacoco-reader.js"
import { loadConfig } from "../src/adapters/driven/yaml-config/config.js"
import { formatOutcomes } from "../src/application/checking/format-outcomes.js"
import { ConfigError } from "../src/application/checking/ports.js"
import { type CheckDeps, runEditChecks, runTaskEndChecks } from "../src/application/checking/run-checks.js"
import type { Check } from "../src/domain/check.js"

let projectDir: string

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "interlint-jacoco-"))
})

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true })
})

function writeFile(path: string, content: string) {
  mkdirSync(dirname(join(projectDir, path)), { recursive: true })
  writeFileSync(join(projectDir, path), content)
}

/** Lines as `jacoco:check` 0.8.14 prints them, from the F10 spike. mvnd puts `[module]` before each one. */
const BUNDLE_LINE = "[WARNING] Rule violated for bundle core: lines covered ratio is 0.50, but expected minimum is 0.80"
const CLASS_LINE = "[WARNING] Rule violated for class demo.Calc: branches covered ratio is 0.00, but expected minimum is 0.50"
const JACOCO_FAILED =
  "[ERROR] Failed to execute goal org.jacoco:jacoco-maven-plugin:0.8.14:check (check) on project core: Coverage checks have not been met. See log for details. -> [Help 1]"
const ALL_MET = "[INFO] All coverage checks have been met."
const NO_EXEC = "[INFO] Skipping JaCoCo execution due to missing execution data file:/repo/target/jacoco.exec"

const output = (...lines: string[]) => `${lines.join("\n")}\n`

describe("readJacocoOutput", () => {
  it("gives each broken rule with its element, counter, current value and expected minimum", () => {
    const result = readJacocoOutput(projectDir, output("[INFO] --- jacoco:0.8.14:check (check) @ core ---", BUNDLE_LINE, CLASS_LINE, JACOCO_FAILED))

    expect(result).toEqual({
      found: true,
      failures: [
        {
          title: "lines covered ratio of each bundle: minimum 0.80",
          type: "coverage",
          violations: [{ text: "Rule violated for bundle core: lines covered ratio is 0.50, but expected minimum is 0.80" }],
        },
        {
          title: "branches covered ratio of each class: minimum 0.50",
          type: "coverage",
          violations: [
            {
              text: "Rule violated for class demo.Calc: branches covered ratio is 0.00, but expected minimum is 0.50",
              className: "demo.Calc",
            },
          ],
        },
      ],
    })
  })

  it("reads the lines mvnd prefixes with the module, and gives each module's rules", () => {
    const result = readJacocoOutput(
      projectDir,
      output(
        `[core] ${BUNDLE_LINE}`,
        "[app] [WARNING] Rule violated for bundle app: lines covered ratio is 0.10, but expected minimum is 0.80",
        JACOCO_FAILED,
      ),
    )

    expect(result.failures).toEqual([
      {
        title: "lines covered ratio of each bundle: minimum 0.80",
        type: "coverage",
        violations: [
          { text: "Rule violated for bundle core: lines covered ratio is 0.50, but expected minimum is 0.80" },
          { text: "Rule violated for bundle app: lines covered ratio is 0.10, but expected minimum is 0.80" },
        ],
      },
    ])
  })

  it("points a class rule at the class's source, in the project or one of its modules", () => {
    writeFile("pom.xml", "<project><modules><module>core</module></modules></project>")
    writeFile("core/pom.xml", "<project/>")
    writeFile("core/src/main/java/demo/Calc.java", "package demo;\nclass Calc {}\n")

    const [failure] = readJacocoOutput(projectDir, output(CLASS_LINE, JACOCO_FAILED)).failures

    expect(failure?.violations).toEqual([
      {
        text: "Rule violated for class demo.Calc: branches covered ratio is 0.00, but expected minimum is 0.50",
        className: "demo.Calc",
        file: "Calc.java",
        path: "core/src/main/java/demo/Calc.java",
      },
    ])
  })

  it("points a nested class at the source of its top-level class", () => {
    writeFile("src/main/java/demo/Calc.java", "package demo;\nclass Calc { static class Part {} }\n")

    const [failure] = readJacocoOutput(
      projectDir,
      output("[WARNING] Rule violated for class demo.Calc.Part: lines covered ratio is 0.00, but expected minimum is 0.50", JACOCO_FAILED),
    ).failures

    expect(failure?.violations[0]?.path).toBe("src/main/java/demo/Calc.java")
  })

  it("names a maximum as JaCoCo does", () => {
    const result = readJacocoOutput(
      projectDir,
      output("[WARNING] Rule violated for package demo: classes missed count is 3, but expected maximum is 0", JACOCO_FAILED),
    )

    expect(result.failures[0]?.title).toBe("classes missed count of each package: maximum 0")
  })

  it("gives a rule broken twice once, as when the build also binds the check execution to the test phase", () => {
    const result = readJacocoOutput(projectDir, output(BUNDLE_LINE, BUNDLE_LINE, JACOCO_FAILED))

    expect(result.failures[0]?.violations).toHaveLength(1)
  })

  it("leaves out the broken rules the build accepts, as with haltOnFailure false, where Maven does not fail on them", () => {
    expect(readJacocoOutput(projectDir, output(BUNDLE_LINE, "[INFO] BUILD SUCCESS"))).toEqual({ found: true, failures: [] })
  })

  it("passes, as found, when every rule was met", () => {
    expect(readJacocoOutput(projectDir, output(NO_EXEC, ALL_MET, "[INFO] BUILD SUCCESS"))).toEqual({ found: true, failures: [] })
  })

  it("finds nothing when JaCoCo checked no rule, as with -Djacoco.skip or no execution data", () => {
    const skipped = "[INFO] Skipping JaCoCo execution because property jacoco.skip is set."

    expect(readJacocoOutput(projectDir, output(skipped, "[INFO] BUILD SUCCESS"))).toEqual({ found: false, failures: [] })
    expect(readJacocoOutput(projectDir, output(NO_EXEC, "[INFO] BUILD SUCCESS"))).toEqual({ found: false, failures: [] })
  })

  it("leaves Maven's output to explain a build that also failed for another reason, such as a failing test", () => {
    const testFailed =
      "[ERROR] Failed to execute goal org.apache.maven.plugins:maven-surefire-plugin:3.5.6:test (default-test) on project app: There are test failures."

    expect(readJacocoOutput(projectDir, output(BUNDLE_LINE, JACOCO_FAILED, testFailed))).toEqual({
      found: true,
      failures: [],
      otherFailure: true,
    })
  })

  it("says the rules are missing when Maven ran with -q, which hides them", () => {
    expect(readJacocoOutput(projectDir, output(JACOCO_FAILED, "[ERROR] -> [Help 1]"))).toEqual({
      found: true,
      failures: [
        {
          title: "Coverage checks have not been met",
          type: "coverage",
          violations: [
            {
              text: "JaCoCo printed no broken rule of core: run the check without -q to see them.",
            },
          ],
        },
      ],
    })
  })

  it("reads lines with terminal colors", () => {
    const colored = "\u001b[1;33mWARNING\u001b[m] Rule violated for bundle core: lines covered ratio is 0.50, but expected minimum is 0.80"

    expect(readJacocoOutput(projectDir, output(`[${colored}`, JACOCO_FAILED)).failures[0]?.violations).toEqual([
      { text: "Rule violated for bundle core: lines covered ratio is 0.50, but expected minimum is 0.80" },
    ])
  })
})

const coverage: Check = {
  name: "coverage",
  run: "./mvnw test jacoco:check@check -fae -Djacoco.append=false",
  report: "jacoco",
  when: "task-end",
}

/** Adapters that answer every run with `result`, as Maven would, and read it with the real JaCoCo reader. */
function depsAnswering(result: { exitCode: number; output: string }) {
  const launched: string[] = []
  const deps: CheckDeps = {
    run: async (command) => (launched.push(command), result),
    readers: { archunit: jacocoReader, maven: jacocoReader, jacoco: jacocoReader, eslint: jacocoReader },
    hasExecutable: () => false,
    lock: (_projectDir, work) => work(),
    changes: {
      lookup: () => ({ changed: true, record: undefined, fingerprint: "", lastModifiedMs: 0 }),
      accept: () => {},
      touch: () => {},
    },
    hasDirectory: () => true,
    editScopes: {},
    removeBrokenClasses: () => [],
    pending: { list: () => [], save: () => true },
    metrics: () => {},
  }
  return { deps, launched }
}

describe("a coverage check at task end", () => {
  it("blocks with each broken rule and tells the agent how to find the classes that lack tests", async () => {
    const { deps } = depsAnswering({ exitCode: 1, output: output(BUNDLE_LINE, JACOCO_FAILED) })

    const outcomes = await runTaskEndChecks(projectDir, { checks: [coverage] }, deps)

    expect(outcomes.map((outcome) => outcome.status)).toEqual(["violations"])
    expect(formatOutcomes(outcomes)).toBe(
      [
        "✗ coverage · lines covered ratio of each bundle: minimum 0.80",
        "",
        "  Rule violated for bundle core: lines covered ratio is 0.50, but expected minimum is 0.80",
        "",
        "  To see which classes lack tests, run ./mvnw jacoco:report and read target/site/jacoco/jacoco.csv in each module.",
        "",
        "Fix these problems before continuing.",
        "",
      ].join("\n"),
    )
  })

  it("passes when every rule was met", async () => {
    const { deps } = depsAnswering({ exitCode: 0, output: output(ALL_MET) })

    const outcomes = await runTaskEndChecks(projectDir, { checks: [coverage] }, deps)

    expect(outcomes.map((outcome) => outcome.status)).toEqual(["passed"])
  })

  it("shows Maven's output, not a coverage failure, when a test fails too", async () => {
    const testFailed =
      "[ERROR] Failed to execute goal org.apache.maven.plugins:maven-surefire-plugin:3.5.6:test (default-test) on project app: There are test failures."
    const { deps } = depsAnswering({ exitCode: 1, output: output(BUNDLE_LINE, JACOCO_FAILED, testFailed) })

    const [outcome] = await runTaskEndChecks(projectDir, { checks: [coverage] }, deps)

    expect(outcome?.status).toBe("failed")
    expect(formatOutcomes([outcome!])).toContain("There are test failures.")
  })

  it("fails, and says JaCoCo checked nothing, when Maven exits 0 without checking any rule", async () => {
    const { deps } = depsAnswering({ exitCode: 0, output: output(NO_EXEC, "[INFO] BUILD SUCCESS") })

    const outcomes = await runTaskEndChecks(projectDir, { checks: [coverage] }, deps)

    expect(outcomes[0]?.status).toBe("failed")
    expect(formatOutcomes(outcomes)).toContain("✗ coverage · the command exited 0 but JaCoCo checked no coverage rule\n")
  })

  it("never runs at edit, even when a Java source changed", async () => {
    const { deps, launched } = depsAnswering({ exitCode: 1, output: output(BUNDLE_LINE, JACOCO_FAILED) })
    const atEdit = { ...coverage, run: "node coverage.mjs", when: "edit" as const }

    const outcomes = await runEditChecks(projectDir, { checks: [atEdit] }, ["src/main/java/demo/Calc.java"], deps)

    expect(outcomes).toEqual([])
    expect(launched).toEqual([])
  })
})

describe("loadConfig with report: jacoco", () => {
  it("reads a coverage check at task end", () => {
    writeFile("interlint.yaml", "checks:\n  - name: coverage\n    run: mvn test jacoco:check\n    report: jacoco\n    when: task-end\n")

    expect(loadConfig(projectDir).checks).toEqual([
      { name: "coverage", run: "mvn test jacoco:check", report: "jacoco", when: "task-end" },
    ])
  })

  it("rejects it at edit: coverage needs the whole test suite", () => {
    writeFile("interlint.yaml", "checks:\n  - name: coverage\n    run: mvn test jacoco:check\n    report: jacoco\n    when: edit\n")

    expect(() => loadConfig(projectDir)).toThrow(ConfigError)
    expect(() => loadConfig(projectDir)).toThrow(
      'interlint.yaml: checks[0].when must be task-end with report jacoco, since coverage needs the whole test suite (got "edit")',
    )
  })
})

describe("jacocoReader.recheck", () => {
  const SINCE_MS = Date.parse("2026-11-08T10:00:00Z")
  const command = "./mvnw test jacoco:check@check -fae -Djacoco.append=false -Dcheckstyle.skip"

  function fileAt(path: string, content: string, ms: number) {
    writeFile(path, content)
    utimesSync(join(projectDir, path), new Date(ms), new Date(ms))
  }

  /** A module's coverage data and the Surefire report of its tests, as a build that ran them leaves both. */
  function execAt(path: string, ms: number, { failures = 0, errors = 0 } = {}) {
    fileAt(path, "exec", ms)
    const report = join(dirname(dirname(path)), "target", "surefire-reports", "TEST-demo.CalcTest.xml")
    fileAt(report, `<?xml version="1.0"?>
<testsuite name="demo.CalcTest" tests="3" errors="${errors}" skipped="0" failures="${failures}">
</testsuite>
`, ms)
  }

  it("runs only the check goals when every module's coverage data was written after the last change", () => {
    writeFile("core/pom.xml", "<project/>")
    writeFile("app/pom.xml", "<project/>")
    execAt("core/target/jacoco.exec", SINCE_MS + 1000)
    execAt("app/target/jacoco.exec", SINCE_MS + 2000)

    expect(jacocoReader.recheck?.(projectDir, command, SINCE_MS)).toBe(
      "./mvnw jacoco:check@check -fae -Djacoco.append=false -Dcheckstyle.skip",
    )
  })

  it("keeps every argument of the command but its lifecycle phases, so profiles and properties still apply", () => {
    execAt("target/jacoco.exec", SINCE_MS + 1000)

    expect(jacocoReader.recheck?.(projectDir, "mvn -Pci clean verify jacoco:check -Dcoverage.min=0.9 -pl core", SINCE_MS)).toBe(
      "mvn -Pci jacoco:check -Dcoverage.min=0.9 -pl core",
    )
  })

  it("gives nothing when a module with tests has no coverage data, as when the build skipped it", () => {
    writeFile("core/pom.xml", "<project/>")
    writeFile("app/pom.xml", "<project/>")
    writeFile("app/src/test/java/app/GreeterTest.java", "class GreeterTest {}")
    execAt("core/target/jacoco.exec", SINCE_MS + 1000)

    expect(jacocoReader.recheck?.(projectDir, command, SINCE_MS)).toBeUndefined()
  })

  it("gives nothing when a module's data is older than the last change, as when its tests were skipped", () => {
    writeFile("core/pom.xml", "<project/>")
    writeFile("app/pom.xml", "<project/>")
    execAt("core/target/jacoco.exec", SINCE_MS + 1000)
    execAt("app/target/jacoco.exec", SINCE_MS - 1000)

    expect(jacocoReader.recheck?.(projectDir, command, SINCE_MS)).toBeUndefined()
  })

  it("gives nothing when a test failed in that build, which still writes the coverage data", () => {
    writeFile("core/pom.xml", "<project/>")
    execAt("core/target/jacoco.exec", SINCE_MS + 1000, { failures: 1 })

    expect(jacocoReader.recheck?.(projectDir, command, SINCE_MS)).toBeUndefined()

    execAt("core/target/jacoco.exec", SINCE_MS + 1000, { errors: 1 })

    expect(jacocoReader.recheck?.(projectDir, command, SINCE_MS)).toBeUndefined()
  })

  it("gives nothing when the build ran only some tests, leaving older Surefire reports of the others", () => {
    writeFile("core/pom.xml", "<project/>")
    execAt("core/target/jacoco.exec", SINCE_MS + 1000)
    fileAt("core/target/surefire-reports/TEST-demo.OtherTest.xml", '<testsuite tests="1" errors="0" failures="0"/>', SINCE_MS - 1000)

    expect(jacocoReader.recheck?.(projectDir, command, SINCE_MS)).toBeUndefined()
  })

  it("gives nothing without coverage data, as after clean with -DskipTests", () => {
    writeFile("core/pom.xml", "<project/>")

    expect(jacocoReader.recheck?.(projectDir, command, SINCE_MS)).toBeUndefined()
  })

  it("gives nothing for a command without a jacoco:check goal", () => {
    execAt("target/jacoco.exec", SINCE_MS + 1000)

    expect(jacocoReader.recheck?.(projectDir, "./mvnw verify", SINCE_MS)).toBeUndefined()
  })
})

describe("a coverage check at task end after the agent's own build", () => {
  const RECHECK = "./mvnw jacoco:check@check -fae"

  /** Answers the recheck and the full check apart, and offers the recheck for fresh coverage data. */
  function reusing(recheckResult: { exitCode: number; output: string } | undefined) {
    const { deps, launched } = depsAnswering({ exitCode: 0, output: output(ALL_MET) })
    deps.run = async (command) => {
      launched.push(command)
      return command === RECHECK && recheckResult ? recheckResult : { exitCode: 0, output: output(ALL_MET) }
    }
    deps.readers = { ...deps.readers, jacoco: { ...jacocoReader, recheck: () => (recheckResult ? RECHECK : undefined) } }
    return { deps, launched }
  }

  it("passes in the last build, without running the tests, when the agent's coverage data meets every rule", async () => {
    const { deps, launched } = reusing({ exitCode: 0, output: output(ALL_MET) })

    const outcomes = await runTaskEndChecks(projectDir, { checks: [coverage] }, deps, { changedOnly: true })

    expect(launched).toEqual([RECHECK])
    expect(outcomes).toEqual([{ check: coverage, durationMs: expect.any(Number), status: "passed", fromBuild: true }])
  })

  it("runs the check when the agent's coverage data breaks a rule", async () => {
    const { deps, launched } = reusing({ exitCode: 1, output: output(BUNDLE_LINE, JACOCO_FAILED) })

    await runTaskEndChecks(projectDir, { checks: [coverage] }, deps, { changedOnly: true })

    expect(launched).toEqual([RECHECK, coverage.run])
  })

  it("runs the check when there is no fresh coverage data to recheck", async () => {
    const { deps, launched } = reusing(undefined)

    await runTaskEndChecks(projectDir, { checks: [coverage] }, deps, { changedOnly: true })

    expect(launched).toEqual([coverage.run])
  })

  it("never rechecks without --changed, as when the user runs the checks", async () => {
    const { deps, launched } = reusing({ exitCode: 0, output: output(ALL_MET) })

    await runTaskEndChecks(projectDir, { checks: [coverage] }, deps)

    expect(launched).toEqual([coverage.run])
  })
})
