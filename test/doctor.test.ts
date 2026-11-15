import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { claudeCodeSettingsFiles } from "../src/adapters/driven/agents/claude-code-settings.js"
import { readProjectFile, writeProjectFile } from "../src/adapters/driven/fs/project-files.js"
import { findsNpxTool } from "../src/adapters/driven/npm/package-bin.js"
import { stateLocation } from "../src/adapters/driven/state/user-state.js"
import { ConfigError } from "../src/application/checking/ports.js"
import { type DoctorDeps, diagnose, formatDiagnosis, hasErrors, npxTool } from "../src/application/diagnosis/diagnose.js"
import { AgentSetupError } from "../src/application/setup/ports.js"
import type { Config } from "../src/domain/check.js"
import { main } from "../src/main.js"

const CONFIG: Config = {
  checks: [
    { name: "archunit", run: "./mvnw test", report: "archunit", when: "edit" },
    { name: "eslint", run: "npx --no -- eslint -f json -o out.json .", report: "eslint", when: "edit", dir: "web" },
  ],
  protected: ["src/test/**"],
}

/** Every check passes: the files on disk are those `init` would write. */
function fakeDeps(overrides: Partial<DoctorDeps> = {}, disk: Record<string, string> = {}): DoctorDeps {
  const files: Record<string, string> = {
    "interlint.yaml": "checks: []",
    ".claude/settings.json": `{"hooks":{"Stop":[{"hooks":[{"command":"interlint hook claude-code stop"}]}]}}`,
    ...disk,
  }
  const planned = (path: string, content: string) => () => [{ path, content, replace: true }]
  return {
    nodeVersion: () => "22.11.0",
    version: () => "1.18.0",
    configFile: "interlint.yaml",
    loadConfig: () => CONFIG,
    readFile: (_, path) => files[path],
    hasDirectory: () => true,
    hasExecutable: (name) => name === "interlint" || name === "mvnd",
    findsCommand: () => true,
    findsNpxTool: () => true,
    agents: {
      "claude-code": planned(
        ".claude/settings.json",
        `{"hooks":{"Stop":[{"hooks":[{"command":"interlint hook claude-code stop"}]}]}}`,
      ),
      opencode: planned(".opencode/plugins/interlint/index.ts", "// interlint plugin"),
      copilot: planned(".github/hooks/interlint.json", `{"interlint":true}`),
      codex: planned(".codex/hooks.json", `{"interlint":true}`),
    },
    files: {
      stateOf: (_, file) => {
        const current = files[file.path]
        if (current === undefined) return "new"
        return current === file.content ? "unchanged" : "changed"
      },
    },
    state: () => ({ dir: "/home/me/.local/state/interlint", writable: true }),
    protectedFiles: () => ({ "src/test/ArchitectureTest.java": "hash" }),
    ...overrides,
  }
}

function findings(deps: DoctorDeps) {
  return diagnose("/project", deps).sections.flatMap(({ findings }) => findings)
}

function errors(deps: DoctorDeps) {
  return findings(deps).filter(({ status }) => status === "error")
}

function warnings(deps: DoctorDeps) {
  return findings(deps).filter(({ status }) => status === "warning")
}

describe("diagnose", () => {
  it("lists every finding as correct when everything is in place (S1)", () => {
    const diagnosis = diagnose("/project", fakeDeps())

    expect(diagnosis.sections.map(({ title }) => title)).toEqual([
      "Environment",
      "Configuration",
      "Tools",
      "Agents",
      "State",
      "Protected files",
    ])
    expect(diagnosis.sections.flatMap(({ findings }) => findings).every(({ status }) => status === "ok")).toBe(true)
    expect(hasErrors(diagnosis)).toBe(false)
  })

  it("names the Node and Interlint versions", () => {
    const text = findings(fakeDeps()).map(({ text }) => text)

    expect(text).toContain("Node 22.11.0")
    expect(text).toContain("Interlint 1.18.0")
  })

  it("is an error on a Node older than 22", () => {
    expect(errors(fakeDeps({ nodeVersion: () => "20.18.0" }))).toEqual([
      { status: "error", text: "Node 20.18.0: Interlint needs Node 22 or later", fix: "install Node 22 or later" },
    ])
  })

  it("says interlint.yaml is missing and suggests interlint init (S3)", () => {
    const deps = fakeDeps({ readFile: (_, path) => (path === "interlint.yaml" ? undefined : fakeDeps().readFile("", path)) })

    expect(errors(deps)).toEqual([
      { status: "error", text: "interlint.yaml not found", fix: "run `interlint init` to detect the checks and write it" },
    ])
  })

  it("gives the configuration error of an invalid interlint.yaml", () => {
    const deps = fakeDeps({
      loadConfig: () => {
        throw new ConfigError("interlint.yaml: checks[0].report must be one of archunit, maven")
      },
    })

    expect(errors(deps)).toEqual([
      {
        status: "error",
        text: "interlint.yaml: checks[0].report must be one of archunit, maven",
        fix: "correct interlint.yaml",
      },
    ])
  })

  it("is an error when the dir of a check does not exist", () => {
    const deps = fakeDeps({ hasDirectory: (path) => !path.endsWith("/web") })

    expect(errors(deps)).toEqual([
      { status: "error", text: `check eslint: its dir "web" does not exist`, fix: "correct its dir in interlint.yaml" },
    ])
  })

  it("detects the executable of a check that is not on the machine (S5)", () => {
    const deps = fakeDeps({ hasExecutable: (name) => name === "interlint", findsCommand: (command) => command.startsWith("npx") })

    expect(errors(deps)).toEqual([
      {
        status: "error",
        text: "check archunit: ./mvnw is not found",
        fix: "install it or put it on the PATH, or change the check's run in interlint.yaml",
      },
    ])
  })

  it("looks for the commands from the check's directory", () => {
    const seen: string[] = []
    findings(fakeDeps({ hasExecutable: (name) => name === "interlint", findsCommand: (_, cwd) => (seen.push(cwd), true) }))

    expect(seen).toEqual(["/project", "/project/web"])
  })

  it("does not need the Maven executable when mvnd runs the Maven checks", () => {
    expect(errors(fakeDeps({ findsCommand: (command) => !command.startsWith("./mvnw") }))).toEqual([])
  })

  it("detects an npm package a check runs with npx that is not installed", () => {
    const deps = fakeDeps({ findsNpxTool: (tool, cwd) => !(tool.bin === "eslint" && cwd === "/project/web") })

    expect(errors(deps)).toEqual([
      {
        status: "error",
        text: "check eslint: eslint is not installed in node_modules",
        fix: "run `npm install` in web",
      },
    ])
  })

  it("names the package of a scoped or versioned npx command, and looks it up as a package", () => {
    const config: Config = { checks: [{ name: "biome", run: "npx @biomejs/biome@1.9 check .", report: "exit-code", when: "task-end" }] }
    const seen: unknown[] = []
    const deps = fakeDeps({ loadConfig: () => config, findsNpxTool: (tool) => (seen.push(tool), false) })

    expect(errors(deps)).toEqual([
      { status: "error", text: "check biome: @biomejs/biome is not installed in node_modules", fix: "run `npm install`" },
    ])
    expect(seen).toEqual([{ package: "@biomejs/biome", bin: "biome" }])
  })

  it("says an interlint.yaml that exists but cannot be read cannot be read, without suggesting init", () => {
    const base = fakeDeps()
    const deps = fakeDeps({
      readFile: (dir, path) => (path === "interlint.yaml" ? { unreadable: "EACCES" } : base.readFile(dir, path)),
    })

    expect(errors(deps)).toEqual([
      { status: "error", text: "interlint.yaml cannot be read (EACCES)", fix: "check that your user may read it" },
    ])
  })

  it("says an agent's file that cannot be read cannot be read", () => {
    const base = fakeDeps()
    const deps = fakeDeps({
      readFile: (dir, path) => (path === ".claude/settings.json" ? { unreadable: "EISDIR" } : base.readFile(dir, path)),
      files: { stateOf: () => { throw new Error("stateOf must not read an unreadable file") } },
    })

    expect(errors(deps)).toContainEqual({
      status: "error",
      text: "Claude Code: .claude/settings.json cannot be read (EISDIR)",
      fix: "check that your user may read it",
    })
  })

  it("warns, without an error, that the Maven edit checks run at task end without mvnd (S2)", () => {
    const deps = fakeDeps({ hasExecutable: (name) => name === "interlint" })
    const diagnosis = diagnose("/project", deps)

    expect(warnings(deps)).toEqual([
      {
        status: "warning",
        text: "mvnd is not on the PATH, so the Maven edit checks run at task end",
        fix: "install mvnd to run them after edits",
      },
    ])
    expect(hasErrors(diagnosis)).toBe(false)
  })

  it("says nothing of mvnd when no edit check uses Maven", () => {
    const config: Config = { checks: [{ name: "lint", run: "npm run lint", report: "exit-code", when: "task-end" }] }
    const text = findings(fakeDeps({ loadConfig: () => config })).map(({ text }) => text)

    expect(text.some((line) => line.includes("mvnd"))).toBe(false)
  })

  it("names the agents whose files match this version", () => {
    const deps = fakeDeps({}, { ".codex/hooks.json": `{"interlint":true}` })

    expect(findings(deps).filter(({ text }) => text.startsWith("Claude Code") || text.startsWith("Codex"))).toEqual([
      { status: "ok", text: "Claude Code: .claude/settings.json is up to date" },
      { status: "ok", text: "Codex: .codex/hooks.json is up to date" },
    ])
  })

  it("detects an agent's hooks of another version and names the command that updates them (S4)", () => {
    const deps = fakeDeps({}, { ".github/hooks/interlint.json": `{"interlint":"old"}` })

    expect(errors(deps)).toEqual([
      {
        status: "error",
        text: "GitHub Copilot: .github/hooks/interlint.json is missing or from another version of Interlint",
        fix: "run `interlint init --agent copilot`",
      },
    ])
  })

  it("detects an agent with some of its files missing (S4)", () => {
    const deps = fakeDeps({
      agents: {
        ...fakeDeps().agents,
        opencode: () => [
          { path: ".opencode/plugins/interlint/index.ts", content: "// interlint plugin", replace: true },
          { path: ".opencode/plugins/interlint/package.json", content: "{}", replace: true },
        ],
      },
    }, { ".opencode/plugins/interlint/index.ts": "// interlint plugin" })

    expect(errors(deps)).toEqual([
      {
        status: "error",
        text: "OpenCode: .opencode/plugins/interlint/package.json is missing or from another version of Interlint",
        fix: "run `interlint init --agent opencode`",
      },
    ])
  })

  it("warns about an agent's file without Interlint's hooks, and errs when no agent is set up (S4)", () => {
    const deps = fakeDeps({}, { ".claude/settings.json": `{"permissions":{}}` })

    expect(findings(deps).filter(({ status }) => status !== "ok")).toEqual([
      {
        status: "warning",
        text: "Claude Code: .claude/settings.json has no Interlint hooks",
        fix: "run `interlint init --agent claude-code`",
      },
      {
        status: "error",
        text: "no agent is set up to run Interlint",
        fix: "run `interlint init --agent opencode|claude-code|copilot|codex`",
      },
    ])
  })

  it("gives the setup error of an agent file that cannot be read", () => {
    const deps = fakeDeps({
      agents: {
        ...fakeDeps().agents,
        "claude-code": () => {
          throw new AgentSetupError(".claude/settings.json is not valid JSON")
        },
      },
    })

    expect(errors(deps)).toContainEqual({
      status: "error",
      text: "Claude Code: .claude/settings.json is not valid JSON",
      fix: "correct it, then run `interlint init --agent claude-code`",
    })
  })

  it("is an error when an agent is set up but interlint is not on the PATH", () => {
    const deps = fakeDeps({ hasExecutable: (name) => name === "mvnd" })

    expect(errors(deps)).toEqual([
      {
        status: "error",
        text: "interlint is not on the PATH, and the agent's hooks run it",
        fix: "run `npm install -g interlint`",
      },
    ])
  })

  it("is an error when the state directory cannot be written", () => {
    const deps = fakeDeps({ state: () => ({ dir: "/state/interlint", writable: false }) })

    expect(errors(deps)).toEqual([
      {
        status: "error",
        text: "/state/interlint cannot be written, so Interlint keeps no state or metrics",
        fix: "make it writable for your user",
      },
    ])
  })

  it("warns about a protected pattern that matches no file", () => {
    const config: Config = { ...CONFIG, protected: ["src/test/**", "eslint.config.js"] }
    const deps = fakeDeps({
      loadConfig: () => config,
      protectedFiles: (_, [pattern]): Record<string, string> => (pattern === "src/test/**" ? { "src/test/A.java": "hash" } : {}),
    })

    expect(warnings(deps)).toEqual([
      {
        status: "warning",
        text: "protected: eslint.config.js matches no file",
        fix: "correct the path or glob in interlint.yaml",
      },
    ])
  })

  it("checks no tool and no protected file without a valid configuration", () => {
    const deps = fakeDeps({
      loadConfig: () => {
        throw new ConfigError("interlint.yaml is not valid YAML")
      },
    })

    expect(diagnose("/project", deps).sections.map(({ title }) => title)).toEqual([
      "Environment",
      "Configuration",
      "Agents",
      "State",
    ])
  })
})

describe("npxTool", () => {
  it("finds the package after -- or after npx's options", () => {
    expect(npxTool("npx --no -- eslint -f json .")).toEqual({ package: "eslint", bin: "eslint" })
    expect(npxTool("npx --no depcruise .")).toEqual({ package: "depcruise", bin: "depcruise" })
    expect(npxTool("npm test")).toBeUndefined()
  })

  it("leaves out the version, and takes the bin of a scoped package from its name", () => {
    expect(npxTool("npx eslint@9 .")).toEqual({ package: "eslint", bin: "eslint" })
    expect(npxTool("npx @biomejs/biome@1.9.4 check")).toEqual({ package: "@biomejs/biome", bin: "biome" })
  })

  it("takes the bin after the package that -p or --package names", () => {
    expect(npxTool("npx -p typescript tsc --noEmit")).toEqual({ package: "typescript", bin: "tsc" })
    expect(npxTool("npx --package=@scope/tools@2 run-it")).toEqual({ package: "@scope/tools", bin: "run-it" })
  })

  it("gives nothing for a command that -c runs, which names no package", () => {
    expect(npxTool(`npx -c "eslint ."`)).toBeUndefined()
  })
})

describe("readProjectFile", () => {
  it("tells a file that is not there from one that cannot be read", () => {
    const root = mkdtempSync(join(tmpdir(), "interlint-read-"))
    try {
      writeFileSync(join(root, "a.txt"), "text")
      mkdirSync(join(root, "dir.txt"))

      expect(readProjectFile(root, "a.txt")).toBe("text")
      expect(readProjectFile(root, "missing.txt")).toBeUndefined()
      expect(readProjectFile(root, "dir.txt")).toEqual({ unreadable: "EISDIR" })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("findsNpxTool", () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "interlint-bin-"))
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it("finds a package installed in the directory or in one above it, as npx does", () => {
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true })
    writeFileSync(join(root, "node_modules", ".bin", "eslint"), "")
    mkdirSync(join(root, "web"))

    expect(findsNpxTool({ package: "eslint", bin: "eslint" }, join(root, "web"))).toBe(true)
    expect(findsNpxTool({ package: "depcruise", bin: "depcruise" }, join(root, "web"))).toBe(false)
  })

  it("finds the .cmd npm writes on Windows", () => {
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true })
    writeFileSync(join(root, "node_modules", ".bin", "eslint.cmd"), "")

    expect(findsNpxTool({ bin: "eslint" }, root)).toBe(true)
  })

  it("finds a scoped package installed by its name, whatever its bin is called", () => {
    mkdirSync(join(root, "node_modules", "@biomejs", "biome"), { recursive: true })
    writeFileSync(join(root, "node_modules", "@biomejs", "biome", "package.json"), "{}")

    expect(findsNpxTool({ package: "@biomejs/biome", bin: "biome" }, root)).toBe(true)
  })
})

describe("stateLocation", () => {
  let stateDir: string

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "interlint-state-"))
    vi.stubEnv("LOCALAPPDATA", stateDir)
    vi.stubEnv("XDG_STATE_HOME", stateDir)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(stateDir, { recursive: true, force: true })
  })

  it("is writable when its parent is, without creating it", () => {
    expect(stateLocation()).toEqual({ dir: join(stateDir, "interlint"), writable: true })
    expect(existsSync(join(stateDir, "interlint"))).toBe(false)
  })

  it("is not writable when a file stands where the directory goes", () => {
    writeFileSync(join(stateDir, "interlint"), "")

    expect(stateLocation().writable).toBe(false)
  })
})

describe("formatDiagnosis", () => {
  it("prints each finding with its fix and sums up errors and warnings", () => {
    const text = formatDiagnosis({
      sections: [
        { title: "Environment", findings: [{ status: "ok", text: "Node 22.11.0" }] },
        {
          title: "Tools",
          findings: [
            { status: "warning", text: "mvnd is not on the PATH", fix: "install mvnd" },
            { status: "error", text: "check a: mvn is not found", fix: "install it" },
          ],
        },
      ],
    })

    expect(text).toBe(
      [
        "Environment",
        "  ✓ Node 22.11.0",
        "Tools",
        "  ! mvnd is not on the PATH",
        "    → install mvnd",
        "  ✗ check a: mvn is not found",
        "    → install it",
        "",
        "1 error, 1 warning.",
        "",
      ].join("\n"),
    )
  })

  it("says everything is in order when there is no error or warning", () => {
    expect(formatDiagnosis({ sections: [{ title: "State", findings: [{ status: "ok", text: "x" }] }] })).toBe(
      ["State", "  ✓ x", "", "Everything is in order.", ""].join("\n"),
    )
  })
})

describe("interlint doctor", () => {
  let projectDir: string
  let stateDir: string
  let binDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "interlint-doctor-"))
    stateDir = mkdtempSync(join(tmpdir(), "interlint-doctor-state-"))
    binDir = mkdtempSync(join(tmpdir(), "interlint-doctor-bin-"))
    vi.stubEnv("LOCALAPPDATA", stateDir)
    vi.stubEnv("XDG_STATE_HOME", stateDir)
    // Only the fake executables, with Node's own directory so `node` is there as on any machine.
    vi.stubEnv("PATH", [binDir, dirname(process.execPath)].join(delimiter))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    for (const dir of [projectDir, stateDir, binDir]) rmSync(dir, { recursive: true, force: true })
  })

  function fakeExecutable(name: string) {
    const file = join(binDir, process.platform === "win32" ? `${name}.cmd` : name)
    writeFileSync(file, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n", { mode: 0o755 })
  }

  async function run(args: string[], cwd = projectDir) {
    let stdout = ""
    let stderr = ""
    const exitCode = await main(["doctor", ...args], {
      cwd,
      stdout: (text) => (stdout += text),
      stderr: (text) => (stderr += text),
    })
    return { exitCode, stdout, stderr }
  }

  /** Every file under `dir` with its modification time, to tell that nothing was written. */
  function snapshot(dir: string): string[] {
    return readdirSync(dir, { recursive: true, encoding: "utf8" })
      .map((path) => `${path} ${statSync(join(dir, path)).mtimeMs}`)
      .sort()
  }

  /** A project with a check that would leave a marker file if it ran, set up for Claude Code as `init` does it. */
  async function setUpProject() {
    writeFileSync(
      join(projectDir, "interlint.yaml"),
      "checks:\n  - name: tests\n    run: node -e \"require('fs').writeFileSync('ran','')\"\n    report: exit-code\n    when: task-end\n",
    )
    fakeExecutable("interlint")
    for (const file of claudeCodeSettingsFiles(projectDir)) writeProjectFile(projectDir, file)
  }

  it("lists every finding as correct and exits 0 when everything is in place (S1)", async () => {
    await setUpProject()

    const { exitCode, stdout } = await run([])

    expect(stdout).toContain("✓ check tests: node is found")
    expect(stdout).toContain("✓ Claude Code: .claude/settings.json is up to date")
    expect(stdout).toContain("Everything is in order.")
    expect(stdout).not.toContain("✗")
    expect(exitCode).toBe(0)
  })

  it("exits 1 and names the fix when the agent's hooks were removed (S2, S4)", async () => {
    await setUpProject()
    writeFileSync(join(projectDir, ".claude", "settings.json"), "{}\n")

    const { exitCode, stdout } = await run([])

    expect(stdout).toContain("! Claude Code: .claude/settings.json has no Interlint hooks")
    expect(stdout).toContain("→ run `interlint init --agent claude-code`")
    expect(stdout).toContain("✗ no agent is set up to run Interlint")
    expect(exitCode).toBe(1)
  })

  it("says interlint.yaml is missing, suggests interlint init and exits 1 (S3)", async () => {
    const { exitCode, stdout } = await run([])

    expect(stdout).toContain("✗ interlint.yaml not found")
    expect(stdout).toContain("→ run `interlint init` to detect the checks and write it")
    expect(exitCode).toBe(1)
  })

  it("detects a check's executable that is not on the machine (S5)", async () => {
    await setUpProject()
    writeFileSync(
      join(projectDir, "interlint.yaml"),
      "checks:\n  - name: gradle\n    run: gradle-not-installed check\n    report: exit-code\n    when: task-end\n",
    )

    const { exitCode, stdout } = await run([])

    expect(stdout).toContain("✗ check gradle: gradle-not-installed is not found")
    expect(exitCode).toBe(1)
  })

  it("writes and changes no file and runs no check (S6)", async () => {
    await setUpProject()
    const project = snapshot(projectDir)
    const state = snapshot(stateDir)

    await run([])

    expect(snapshot(projectDir)).toEqual(project)
    expect(snapshot(stateDir)).toEqual(state)
    expect(readdirSync(projectDir)).not.toContain("ran")
  })

  it("runs in another directory with --cwd (S7)", async () => {
    await setUpProject()

    const { exitCode, stdout } = await run(["--cwd", projectDir], tmpdir())

    expect(stdout).toContain(`Interlint doctor in ${projectDir}`)
    expect(stdout).toContain("✓ interlint.yaml is valid, with 1 check")
    expect(exitCode).toBe(0)
  })

  it("says interlint.yaml cannot be read when it is not a file, and exits 1", async () => {
    mkdirSync(join(projectDir, "interlint.yaml"))

    const { exitCode, stdout } = await run([])

    expect(stdout).toContain("✗ interlint.yaml cannot be read (EISDIR)")
    expect(stdout).not.toContain("interlint init` to detect")
    expect(exitCode).toBe(1)
  })

  it("exits 2 for a directory that does not exist", async () => {
    const { exitCode, stderr } = await run(["--cwd", join(projectDir, "missing")])

    expect(stderr).toContain("does not exist")
    expect(exitCode).toBe(2)
  })

  it("keeps the project's own settings file as it is", async () => {
    await setUpProject()
    const before = readFileSync(join(projectDir, ".claude", "settings.json"), "utf8")

    await run([])

    expect(readFileSync(join(projectDir, ".claude", "settings.json"), "utf8")).toBe(before)
  })
})
