import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { eslintOnFiles } from "../src/adapters/driven/eslint/eslint-scope.js"
import { eslintReader, parseEslintJson } from "../src/adapters/driven/eslint/report-reader.js"
import { loadConfig } from "../src/adapters/driven/yaml-config/config.js"
import { formatOutcomes } from "../src/application/checking/format-outcomes.js"
import type { PendingEdit, ReportReader } from "../src/application/checking/ports.js"
import { type CheckDeps, runEditChecks, runTaskEndChecks } from "../src/application/checking/run-checks.js"
import { type Check, isSourceOf } from "../src/domain/check.js"
import { ESLINT_COMMAND, ESLINT_REPORT } from "../src/domain/eslint-command.js"
import { metricEventOf } from "../src/domain/metric.js"
import { summarize } from "../src/domain/metric-summary.js"

const RUN = ESLINT_COMMAND
const eslintEdit: Check = { name: "eslint", run: RUN, report: "eslint", when: "edit" }

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "interlint-eslint-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

interface Message {
  ruleId: string | null
  severity: 1 | 2
  message: string
  line?: number
  fatal?: boolean
}

/** One entry of ESLint's JSON report, with the absolute path ESLint gives. */
function entry(file: string, ...messages: Message[]) {
  return { filePath: join(dir, ...file.split("/")), messages }
}

const anyError: Message = {
  ruleId: "@typescript-eslint/no-explicit-any",
  severity: 2,
  message: "Unexpected any. Specify a different type.",
  line: 1,
}
const constWarning: Message = {
  ruleId: "prefer-const",
  severity: 1,
  message: "'unused' is never reassigned. Use 'const' instead.",
  line: 4,
}

function write(file: string, content = "") {
  const path = join(dir, ...file.split("/"))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

/** Writes ESLint's report where a run in `cwd` leaves it. */
function writeReport(entries: unknown, cwd = dir) {
  const path = join(cwd, ...ESLINT_REPORT.split("/"))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(entries))
}

describe("parseEslintJson", () => {
  it("gives an error with its rule, file and line", () => {
    const json = JSON.stringify([entry("src/orders/order.ts", anyError), entry("src/orders/clean.ts")])

    expect(parseEslintJson(json, dir)).toEqual([
      {
        title: "@typescript-eslint/no-explicit-any",
        type: "eslint",
        violations: [
          { text: "Unexpected any. Specify a different type.", file: "order.ts", line: 1, path: "src/orders/order.ts" },
        ],
      },
    ])
  })

  it("groups the errors of one rule and leaves the warnings out when there are errors", () => {
    const json = JSON.stringify([
      entry("src/a.ts", anyError, constWarning),
      entry("src/b.ts", { ...anyError, line: 7 }),
    ])

    const failures = parseEslintJson(json, dir)

    expect(failures.map((failure) => failure.title)).toEqual(["@typescript-eslint/no-explicit-any"])
    expect(failures[0]?.violations.map((violation) => `${violation.path}:${violation.line}`)).toEqual(["src/a.ts:1", "src/b.ts:7"])
  })

  it("gives the warnings when there is no error, for a run that fails on --max-warnings", () => {
    const failures = parseEslintJson(JSON.stringify([entry("src/a.ts", constWarning)]), dir)

    expect(failures.map((failure) => failure.title)).toEqual(["prefer-const"])
  })

  it("never gives the warning of a file ESLint ignores", () => {
    const json = JSON.stringify([
      entry("src/generated/gen.ts", {
        ruleId: null,
        severity: 1,
        message: 'File ignored because of a matching ignore pattern. Use "--no-ignore" to disable file ignore settings.',
      }),
      entry("README.md", { ruleId: null, severity: 1, message: "File ignored because no matching configuration was supplied." }),
    ])

    expect(parseEslintJson(json, dir)).toEqual([])
  })

  it("gives an error without a rule, such as a file that does not parse, with its file and line", () => {
    const json = JSON.stringify([
      entry("src/broken.ts", { ruleId: null, severity: 2, fatal: true, message: "Parsing error: '}' expected.", line: 2 }),
    ])

    expect(parseEslintJson(json, dir)).toEqual([
      {
        title: "ESLint",
        type: "eslint",
        violations: [{ text: "Parsing error: '}' expected.", file: "broken.ts", line: 2, path: "src/broken.ts" }],
      },
    ])
  })

  it("gives nothing for a report that is not ESLint's JSON", () => {
    expect(parseEslintJson("not json", dir)).toEqual([])
    expect(parseEslintJson('{"filePath":"a.ts"}', dir)).toEqual([])
    expect(parseEslintJson('[{"filePath":7,"messages":"none"},null]', dir)).toEqual([])
  })
})

describe("eslintReader", () => {
  it("reads the report the run wrote", () => {
    const before = eslintReader.snapshot(dir)
    writeReport([entry("src/a.ts", anyError)])

    const result = eslintReader.read(dir, before, "")

    expect(result.found).toBe(true)
    expect(result.failures.map((failure) => failure.title)).toEqual(["@typescript-eslint/no-explicit-any"])
  })

  it("ignores a report left by an earlier run", () => {
    writeReport([entry("src/a.ts", anyError)])

    expect(eslintReader.read(dir, eslintReader.snapshot(dir), "")).toEqual({ found: false, failures: [] })
  })

  it("finds no report when the run wrote none", () => {
    expect(eslintReader.read(dir, eslintReader.snapshot(dir), "")).toEqual({ found: false, failures: [] })
  })
})

describe("eslintOnFiles", () => {
  it("checks only the files instead of the whole project", () => {
    write("src/orders/order.ts")
    write("src/orders/line.tsx")

    expect(eslintOnFiles(RUN, ["src/orders/order.ts", "src/orders/line.tsx"], dir)).toBe(
      `npx --no -- eslint -f json -o ${ESLINT_REPORT} src/orders/order.ts src/orders/line.tsx`,
    )
  })

  it("silences the warning of an ignored file when the project has a flat configuration", () => {
    write("eslint.config.mjs")
    write("src/orders/order.ts")

    expect(eslintOnFiles(RUN, ["src/orders/order.ts"], dir)).toBe(
      `npx --no -- eslint -f json -o ${ESLINT_REPORT} --no-warn-ignored src/orders/order.ts`,
    )
  })

  it("leaves out a file that is gone, which ESLint would fail on", () => {
    write("src/a.ts")

    expect(eslintOnFiles(RUN, ["src/a.ts", "src/deleted.ts"], dir)).toBe(
      `npx --no -- eslint -f json -o ${ESLINT_REPORT} src/a.ts`,
    )
  })

  it.each([
    ["does not end with the whole project", `npx --no -- eslint -f json -o ${ESLINT_REPORT} src`],
    ["is the project's script", `npm run lint -- -f json -o ${ESLINT_REPORT} .`],
    ["is more than one program", `npx --no -- eslint -f json -o ${ESLINT_REPORT} . && echo done .`],
  ])("leaves the command as it is when it %s", (_case, command) => {
    write("src/a.ts")

    expect(eslintOnFiles(command, ["src/a.ts"], dir)).toBe(command)
  })

  it.each([["src/[id]/page.tsx"], ["src/my file.ts"], ["-rf.ts"]])(
    "leaves the command as it is for a file the shell or ESLint could read as something else: %s",
    (file) => {
      write(file)

      expect(eslintOnFiles(RUN, [file], dir)).toBe(RUN)
    },
  )

  it("names a file once, however many times it was edited", () => {
    write("src/a.ts")

    expect(eslintOnFiles(RUN, ["src/a.ts", "src/a.ts"], dir)).toBe(
      `npx --no -- eslint -f json -o ${ESLINT_REPORT} src/a.ts`,
    )
  })

  it("leaves the command as it is for more files than a command line takes", () => {
    const files = Array.from({ length: 51 }, (_, index) => `src/file${index}.ts`)
    for (const file of files) write(file)

    expect(eslintOnFiles(RUN, files, dir)).toBe(RUN)
    expect(eslintOnFiles(RUN, files.slice(0, 50), dir)).toContain(" src/file49.ts")
  })

  it("leaves the command as it is when every file is gone", () => {
    expect(eslintOnFiles(RUN, ["src/deleted.ts"], dir)).toBe(RUN)
  })
})

describe("sources of report: eslint", () => {
  it.each([["src/a.ts"], ["src/A.TSX"], ["a.mts"], ["a.cts"], ["a.js"], ["a.jsx"], ["a.mjs"], ["eslint.config.cjs"]])(
    "%s is one",
    (file) => {
      expect(isSourceOf("eslint", file)).toBe(true)
    },
  )

  it.each([["README.md"], ["package.json"], ["src/Order.java"], ["styles.css"], ["notes.tsv"]])("%s is not one", (file) => {
    expect(isSourceOf("eslint", file)).toBe(false)
  })

  it("a TypeScript file is not a source of a Maven check", () => {
    expect(isSourceOf("maven", "src/a.ts")).toBe(false)
    expect(isSourceOf("archunit", "src/a.ts")).toBe(false)
  })
})

/** What a fake run of ESLint leaves: the entries of its report, or no report at all, and how it exits. */
interface FakeRun {
  exitCode: number
  report?: unknown
  output?: string
}

/** The real reader and scope, with a command runner that writes the report ESLint would. */
function eslintDeps(fake: FakeRun, options: { mvnd?: boolean } = {}) {
  const launched: string[] = []
  const saved = new Map<string, PendingEdit[]>()
  const unused: ReportReader = { snapshot: () => new Map(), read: () => ({ found: true, failures: [] }) }
  const deps: CheckDeps = {
    run: async (command, cwd) => {
      launched.push(command)
      if (fake.report !== undefined) writeReport(fake.report, cwd)
      return { exitCode: fake.exitCode, output: fake.output ?? "" }
    },
    readers: { archunit: unused, maven: unused, jacoco: unused, eslint: eslintReader },
    hasExecutable: (name) => options.mvnd === true && name === "mvnd",
    lock: (_projectDir, work) => work(),
    changes: {
      lookup: () => ({ changed: true, record: undefined, fingerprint: "", lastModifiedMs: 0 }),
      accept: () => {},
      touch: () => {},
    },
    hasDirectory: () => true,
    editScopes: { eslint: eslintOnFiles },
    removeBrokenClasses: () => [],
    pending: {
      list: (projectDir, check) => saved.get(`${projectDir}|${check}`) ?? [],
      save: (projectDir, check, edits) => (saved.set(`${projectDir}|${check}`, edits), true),
    },
    metrics: () => {},
  }
  return { deps, launched }
}

describe("an eslint check at edit", () => {
  it("runs ESLint on the edited file only, without mvnd, and shows only its failures", async () => {
    write("src/orders/order.ts")
    const { deps, launched } = eslintDeps({
      exitCode: 1,
      report: [entry("src/orders/order.ts", anyError), entry("src/orders/other.ts", { ...anyError, line: 9 })],
    })

    const outcomes = await runEditChecks(dir, { checks: [eslintEdit] }, ["src/orders/order.ts"], deps)

    expect(launched).toEqual([`npx --no -- eslint -f json -o ${ESLINT_REPORT} src/orders/order.ts`])
    expect(formatOutcomes(outcomes)).toBe(
      [
        "✗ eslint · @typescript-eslint/no-explicit-any",
        "",
        "  Unexpected any. Specify a different type.",
        "    at src/orders/order.ts:1",
        "",
        "Fix these problems before continuing.",
        "",
      ].join("\n"),
    )
  })

  it("does not run for a file that is not one of its sources", async () => {
    const { deps, launched } = eslintDeps({ exitCode: 1, report: [entry("README.md", anyError)] })

    expect(await runEditChecks(dir, { checks: [eslintEdit] }, ["README.md"], deps)).toEqual([])
    expect(launched).toEqual([])
  })

  it("runs in its own project of a workspace, and leaves the Maven checks of another alone", async () => {
    write("web/src/app.ts")
    const maven: Check = { name: "api/checkstyle", run: "./mvnw -q checkstyle:check", report: "maven", when: "edit", dir: "api" }
    const web: Check = { ...eslintEdit, name: "web/eslint", dir: "web" }
    const { deps, launched } = eslintDeps(
      { exitCode: 1, report: [{ filePath: join(dir, "web", "src", "app.ts"), messages: [anyError] }] },
      { mvnd: true },
    )

    const outcomes = await runEditChecks(dir, { checks: [maven, web] }, ["web/src/app.ts"], deps)

    expect(launched).toEqual([`npx --no -- eslint -f json -o ${ESLINT_REPORT} src/app.ts`])
    expect(formatOutcomes(outcomes)).toContain("    at web/src/app.ts:1")
  })

  it("passes when the failures are all in files the edit did not change", async () => {
    write("src/a.ts")
    const { deps } = eslintDeps({ exitCode: 1, report: [entry("src/b.ts", anyError)] })

    const outcomes = await runEditChecks(dir, { checks: [eslintEdit] }, ["src/a.ts"], deps)

    expect(outcomes.map((outcome) => outcome.status)).toEqual(["passed"])
  })
})

describe("an eslint check at task end", () => {
  it("runs ESLint on the whole project and fails on any error", async () => {
    const { deps, launched } = eslintDeps({ exitCode: 1, report: [entry("src/a.ts", anyError, constWarning)] })

    const outcomes = await runTaskEndChecks(dir, { checks: [eslintEdit] }, deps)

    expect(launched).toEqual([RUN])
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["violations"])
    expect(formatOutcomes(outcomes)).not.toContain("prefer-const")
  })

  it("passes, and shows nothing, with warnings the project accepts", async () => {
    const { deps } = eslintDeps({ exitCode: 0, report: [entry("src/a.ts", constWarning)] })

    const outcomes = await runTaskEndChecks(dir, { checks: [eslintEdit] }, deps)

    expect(outcomes.map((outcome) => outcome.status)).toEqual(["passed"])
    expect(formatOutcomes(outcomes)).toBe("")
  })

  it("shows the warnings when ESLint fails on them alone", async () => {
    const { deps } = eslintDeps({
      exitCode: 1,
      report: [entry("src/a.ts", constWarning)],
      output: "ESLint found too many warnings (maximum: 0).",
    })

    expect(formatOutcomes(await runTaskEndChecks(dir, { checks: [eslintEdit] }, deps))).toContain("✗ eslint · prefer-const")
  })

  it("shows ESLint's output, not a rule, when ESLint itself fails", async () => {
    const { deps } = eslintDeps({
      exitCode: 2,
      output: "Oops! Something went wrong! :(\n\nError [ERR_MODULE_NOT_FOUND]: Cannot find package 'not-installed'",
    })

    const outcomes = await runTaskEndChecks(dir, { checks: [eslintEdit] }, deps)

    expect(outcomes.map((outcome) => outcome.status)).toEqual(["failed"])
    const text = formatOutcomes(outcomes)
    expect(text).toContain("✗ eslint · the command failed (exit code 2) and left no ESLint failures")
    expect(text).toContain("    Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'not-installed'")
  })

  it("shows the output when the dependencies are not installed, even with the report of an earlier run", async () => {
    writeReport([entry("src/a.ts", anyError)])
    const { deps } = eslintDeps({ exitCode: 1, output: "npm error npx canceled due to missing packages" })

    const outcomes = await runTaskEndChecks(dir, { checks: [eslintEdit] }, deps)

    expect(outcomes.map((outcome) => outcome.status)).toEqual(["failed"])
  })
})

describe("report: eslint in interlint.yaml", () => {
  it("is a format a check can use, at edit and at task end", () => {
    write(
      "interlint.yaml",
      [
        "checks:",
        "  - name: eslint",
        `    run: ${RUN}`,
        "    report: eslint",
        "    when: edit",
        "  - name: eslint-all",
        `    run: ${RUN}`,
        "    report: eslint",
        "    when: task-end",
        "",
      ].join("\n"),
    )

    expect(loadConfig(dir).checks.map((check) => `${check.report} ${check.when}`)).toEqual(["eslint edit", "eslint task-end"])
  })
})

describe("the metrics of an eslint check", () => {
  const line = {
    v: 1,
    at: "2026-11-10T10:00:00.000Z",
    interlint: "1.14.0",
    projectKey: "k",
    project: "web",
    when: "edit",
    check: "eslint",
    report: "eslint",
    result: "violations",
    durationMs: 2300,
    violations: [{ rule: "@typescript-eslint/no-explicit-any", type: "eslint", file: "src/a.ts" }],
  }

  it("are read back, and counted as one more type", () => {
    const event = metricEventOf(line)

    expect(event?.report).toBe("eslint")
    const summary = summarize([event!])
    expect(summary.byType).toEqual([{ type: "eslint", violations: 1 }])
    expect(summary.rules).toEqual([{ rule: "@typescript-eslint/no-explicit-any", type: "eslint", violations: 1 }])
  })
})
