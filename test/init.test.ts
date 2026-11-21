import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { loadConfig } from "../src/adapters/driven/yaml-config/config.js"
import { main } from "../src/main.js"

let projectDir: string
let binDir: string

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "interlint-init-"))
  binDir = mkdtempSync(join(tmpdir(), "interlint-bin-"))
  vi.stubEnv("PATH", binDir)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(projectDir, { recursive: true, force: true })
  rmSync(binDir, { recursive: true, force: true })
})

function writeFile(path: string, content: string) {
  mkdirSync(dirname(join(projectDir, path)), { recursive: true })
  writeFileSync(join(projectDir, path), content)
}

function archTest(path: string) {
  const name = path.slice(path.lastIndexOf("/") + 1, -".java".length)
  writeFile(
    path,
    `package com.acme;\n\nimport com.tngtech.archunit.junit.ArchTest;\n\nclass ${name} {\n  @ArchTest\n  static final ArchRule RULE = noClasses().should().accessClassesThat().haveSimpleName("X");\n}\n`,
  )
}

function installMavenDaemon() {
  const file = join(binDir, process.platform === "win32" ? "mvnd.cmd" : "mvnd")
  writeFileSync(file, "")
  chmodSync(file, 0o755)
}

async function run(...args: string[]) {
  let stdout = ""
  let stderr = ""
  const exitCode = await main(args, {
    cwd: projectDir,
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
  })
  return { exitCode, stdout, stderr }
}

const PLUGIN_SOURCE = join(import.meta.dirname, "..", "integrations", "opencode", "interlint", "index.ts")
const PLUGIN_COPY = join(".opencode", "plugins", "interlint", "index.ts")

const readConfig = () => readFileSync(join(projectDir, "interlint.yaml"), "utf8")

describe("interlint init", () => {
  it("writes an architecture check that runs only the classes with @ArchTest", async () => {
    writeFile("mvnw", "")
    archTest("src/test/java/com/acme/architecture/LayersTest.java")
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    writeFile("src/test/java/com/acme/OrderServiceTest.java", "class OrderServiceTest { @Test void works() {} }\n")
    writeFile("src/main/java/com/acme/Order.java", "// Mentions @ArchTest but is not a test.\nclass Order {}\n")

    const { exitCode, stderr } = await run("init")

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
    expect(loadConfig(projectDir)).toEqual({
      checks: [
        {
          name: "architecture",
          run: "./mvnw -q test -Dtest=ArchitectureRulesTest,LayersTest",
          report: "archunit",
          when: "edit",
          every: 5, lines: 200,
        },
      ],
      protected: ["src/test/java/**/ArchitectureRulesTest.java", "src/test/java/**/LayersTest.java"],
    })
  })

  it("ignores @ArchTest when it only appears in a comment or a string", async () => {
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    writeFile(
      "src/test/java/com/acme/OrderServiceTest.java",
      [
        "class OrderServiceTest {",
        "  // @ArchTest static final ArchRule OLD = ...;",
        "  /* @ArchTest",
        "     static final ArchRule DISABLED = ...; */",
        '  String note = "see @ArchTest"; // http://example.com',
        "}",
        "",
      ].join("\n"),
    )

    await run("init")

    expect(loadConfig(projectDir).checks[0]?.run).toBe("mvn -q test -Dtest=ArchitectureRulesTest")
  })

  it("finds @ArchTest after a char literal holding a double quote", async () => {
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    writeFile("src/test/java/com/acme/QuoteRulesTest.java", `class QuoteRulesTest { char q = '"'; @ArchTest Object r = "x"; }\n`)

    await run("init")

    expect(loadConfig(projectDir).checks[0]?.run).toBe("mvn -q test -Dtest=ArchitectureRulesTest,QuoteRulesTest")
  })

  it("skips a directory whose name ends in .java", async () => {
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    mkdirSync(join(projectDir, "src", "test", "java", "legacy.java"), { recursive: true })

    const { exitCode, stderr } = await run("init")

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
    expect(loadConfig(projectDir).checks[0]?.run).toBe("mvn -q test -Dtest=ArchitectureRulesTest")
  })

  it("leaves out a class whose file name is not a plain Java name, so it never reaches the shell", async () => {
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    archTest("src/test/java/com/acme/Evil$(id).java")

    await run("init")

    expect(loadConfig(projectDir).checks[0]?.run).toBe("mvn -q test -Dtest=ArchitectureRulesTest")
  })

  it("accepts class names with non-ASCII letters", async () => {
    archTest("src/test/java/com/acme/ReglasDeArquitecturaÑTest.java")

    await run("init")

    expect(loadConfig(projectDir).checks[0]?.run).toBe("mvn -q test -Dtest=ReglasDeArquitecturaÑTest")
  })

  it("names a class once when two packages have one with the same name", async () => {
    archTest("src/test/java/com/acme/orders/ArchitectureRulesTest.java")
    archTest("src/test/java/com/acme/billing/ArchitectureRulesTest.java")

    await run("init")

    expect(loadConfig(projectDir).checks[0]?.run).toBe("mvn -q test -Dtest=ArchitectureRulesTest")
  })

  it("keeps a long run command on one line", async () => {
    for (const name of ["AdaptersRulesTest", "ApplicationRulesTest", "DomainRulesTest", "NamingRulesTest"]) {
      archTest(`src/test/java/com/acme/${name}.java`)
    }

    await run("init")

    expect(readConfig()).toContain(
      "    run: mvn -q test -Dtest=AdaptersRulesTest,ApplicationRulesTest,DomainRulesTest,NamingRulesTest\n",
    )
  })

  it("says so when the --cwd directory does not exist", async () => {
    const { exitCode, stderr } = await run("init", "--cwd", "missing")

    expect(exitCode).toBe(2)
    expect(stderr).toBe(`interlint: ${join(projectDir, "missing")} does not exist\n`)
  })

  it("writes the same check with and without mvnd on the PATH", async () => {
    writeFile("mvnw", "")
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    await run("init")
    const withoutDaemon = readConfig()

    installMavenDaemon()
    expect((await run("init", "--force")).exitCode).toBe(0)

    expect(readConfig()).toBe(withoutDaemon)
    expect(loadConfig(projectDir).checks[0]).toMatchObject({ run: "./mvnw -q test -Dtest=ArchitectureRulesTest", when: "edit", every: 5, lines: 200 })
  })

  it("uses the Windows wrapper when only mvnw.cmd is there", async () => {
    writeFile("mvnw.cmd", "")
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")

    await run("init")

    expect(loadConfig(projectDir).checks[0]?.run).toBe("./mvnw -q test -Dtest=ArchitectureRulesTest")
  })

  it("uses mvn when the project has no Maven Wrapper", async () => {
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")

    await run("init")

    expect(loadConfig(projectDir).checks[0]?.run).toBe("mvn -q test -Dtest=ArchitectureRulesTest")
  })

  it("says what it detected and what it wrote", async () => {
    writeFile("mvnw", "")
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    installMavenDaemon()

    const { stdout } = await run("init")

    expect(stdout).toBe(
      [
        "Detected:",
        "  ArchUnit tests: ArchitectureRulesTest",
        "  Maven: ./mvnw (Maven Wrapper)",
        "  mvnd: on the PATH, so the ArchUnit check runs after every 5 edited files or 200 written lines",
        "",
        "Wrote:",
        "  interlint.yaml",
        "",
      ].join("\n"),
    )
  })

  it("says the architecture check waits for task end without mvnd", async () => {
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")

    const { stdout } = await run("init")

    expect(stdout).toContain(
      "  Maven: mvn (no Maven Wrapper)\n  mvnd: not on the PATH, so the ArchUnit check runs at task end; install mvnd to run it after every 5 edited files or 200 written lines\n",
    )
  })

  it("does not overwrite a different interlint.yaml without --force", async () => {
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    writeFile("interlint.yaml", "# The team's own config\n")

    const { exitCode, stdout, stderr } = await run("init")

    expect(exitCode).toBe(2)
    expect(stdout).toBe("")
    expect(stderr).toBe(
      "interlint: interlint.yaml already exists and is different from what init would write; rerun with --force to replace it\n",
    )
    expect(readConfig()).toBe("# The team's own config\n")
  })

  it("replaces a different interlint.yaml with --force", async () => {
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    writeFile("interlint.yaml", "# The team's own config\n")

    const { exitCode, stdout } = await run("init", "--force")

    expect(exitCode).toBe(0)
    expect(stdout).toContain("Wrote:\n  interlint.yaml\n")
    expect(loadConfig(projectDir).checks).toHaveLength(1)
  })

  it("leaves the same result when it runs twice", async () => {
    writeFile("mvnw", "")
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    await run("init")
    const first = readConfig()

    const { exitCode, stdout, stderr } = await run("init")

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
    expect(readConfig()).toBe(first)
    expect(stdout).toContain("Unchanged:\n  interlint.yaml\n")
    expect(stdout).not.toContain("Wrote:")
  })

  it("treats a checked-out copy with Windows line endings as the same file", async () => {
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    await run("init")
    writeFile("interlint.yaml", readConfig().replaceAll("\n", "\r\n"))

    const { exitCode, stdout } = await run("init")

    expect(exitCode).toBe(0)
    expect(stdout).toContain("Unchanged:\n  interlint.yaml\n")
  })

  it("says there is nothing to check and writes nothing", async () => {
    writeFile("mvnw", "")
    writeFile("src/test/java/com/acme/OrderServiceTest.java", "class OrderServiceTest {}\n")

    const { exitCode, stdout, stderr } = await run("init")

    expect(exitCode).toBe(2)
    expect(stdout).toBe("")
    expect(stderr).toBe(
      "interlint: nothing to check: no pom.xml was found here or up to three levels below. No npm project with ESLint or dependency-cruiser (eslint in package.json and an eslint.config file, or dependency-cruiser in package.json and a .dependency-cruiser file) was found either. Nothing was written.\n",
    )
    expect(existsSync(join(projectDir, "interlint.yaml"))).toBe(false)
  })

  it("works on another directory with --cwd", async () => {
    archTest("api/src/test/java/com/acme/ArchitectureRulesTest.java")

    expect((await run("init", "--cwd", "api")).exitCode).toBe(0)
    expect(existsSync(join(projectDir, "api", "interlint.yaml"))).toBe(true)
  })

  it("exits 2 for an unknown agent", async () => {
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")

    const { exitCode, stderr } = await run("init", "--agent", "cursor")

    expect(exitCode).toBe(2)
    expect(stderr).toContain('--agent must be opencode, claude-code, copilot or codex (got "cursor")')
    expect(existsSync(join(projectDir, "interlint.yaml"))).toBe(false)
  })
})

describe("interlint init --agent opencode", () => {
  beforeEach(() => {
    writeFile("mvnw", "")
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
  })

  it("copies the OpenCode plugin to .opencode/plugins/interlint/", async () => {
    const { exitCode, stdout, stderr } = await run("init", "--agent", "opencode")

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
    expect(readFileSync(join(projectDir, PLUGIN_COPY), "utf8")).toBe(readFileSync(PLUGIN_SOURCE, "utf8"))
    expect(stdout).toContain("Wrote:\n  interlint.yaml\n  .opencode/plugins/interlint/index.ts\n")
  })

  it("leaves opencode.json and opencode.jsonc as they are", async () => {
    const config = '{\n  // The team\'s settings\n  "plugins": ["./elsewhere"]\n}\n'
    writeFile("opencode.jsonc", config)

    await run("init", "--agent", "opencode")

    expect(readFileSync(join(projectDir, "opencode.jsonc"), "utf8")).toBe(config)
    expect(existsSync(join(projectDir, "opencode.json"))).toBe(false)
  })

  it("leaves the same result when it runs twice", async () => {
    await run("init", "--agent", "opencode")

    const { exitCode, stdout } = await run("init", "--agent", "opencode")

    expect(exitCode).toBe(0)
    expect(stdout).toContain("Unchanged:\n  interlint.yaml\n  .opencode/plugins/interlint/index.ts\n")
    expect(readFileSync(join(projectDir, PLUGIN_COPY), "utf8")).toBe(readFileSync(PLUGIN_SOURCE, "utf8"))
  })

  it("replaces an outdated copy of the plugin without --force", async () => {
    writeFile(PLUGIN_COPY, "// An older Interlint plugin\n")

    const { exitCode, stdout } = await run("init", "--agent", "opencode")

    expect(exitCode).toBe(0)
    expect(stdout).toContain("  .opencode/plugins/interlint/index.ts\n")
    expect(readFileSync(join(projectDir, PLUGIN_COPY), "utf8")).toBe(readFileSync(PLUGIN_SOURCE, "utf8"))
  })

  it("updates the plugin and keeps a different interlint.yaml", async () => {
    writeFile("interlint.yaml", "# The team's own config\n")
    writeFile(PLUGIN_COPY, "// An older Interlint plugin\n")

    const { exitCode, stdout, stderr } = await run("init", "--agent", "opencode")

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
    expect(stdout).toContain(
      "Wrote:\n  .opencode/plugins/interlint/index.ts\n\nKept:\n  interlint.yaml (differs from what init would write; rerun with --force to replace it)\n",
    )
    expect(readConfig()).toBe("# The team's own config\n")
    expect(readFileSync(join(projectDir, PLUGIN_COPY), "utf8")).toBe(readFileSync(PLUGIN_SOURCE, "utf8"))
  })

  it("replaces a different interlint.yaml with --force", async () => {
    writeFile("interlint.yaml", "# The team's own config\n")

    const { exitCode, stdout } = await run("init", "--agent", "opencode", "--force")

    expect(exitCode).toBe(0)
    expect(stdout).toContain("Wrote:\n  interlint.yaml\n  .opencode/plugins/interlint/index.ts\n")
    expect(stdout).not.toContain("Kept:")
    expect(loadConfig(projectDir).checks).toHaveLength(1)
  })

  it("does not copy the plugin when there are no ArchUnit tests", async () => {
    rmSync(join(projectDir, "src"), { recursive: true })

    expect((await run("init", "--agent", "opencode")).exitCode).toBe(2)
    expect(existsSync(join(projectDir, ".opencode"))).toBe(false)
  })

  it("installs no plugin without --agent", async () => {
    await run("init")

    expect(existsSync(join(projectDir, ".opencode"))).toBe(false)
  })
})

describe("interlint init --agent claude-code", () => {
  const SETTINGS = join(".claude", "settings.json")
  const POST_EDIT = { type: "command", command: "interlint hook claude-code post-edit", timeout: 120, statusMessage: "Interlint: running checks" }
  const STOP = { type: "command", command: "interlint hook claude-code stop", timeout: 600, statusMessage: "Interlint: running checks" }
  const SUBAGENT_STOP = { type: "command", command: "interlint hook claude-code subagent-stop", timeout: 600, statusMessage: "Interlint: running checks" }
  const SUBAGENT_START = { type: "command", command: "interlint hook claude-code subagent-start", timeout: 30 }
  const SESSION_START = { type: "command", command: "interlint hook claude-code session-start", timeout: 30 }
  const PRE_EDIT = { type: "command", command: "interlint hook claude-code pre-edit", timeout: 30 }
  const USER_PROMPT = { type: "command", command: "interlint hook claude-code user-prompt", timeout: 120 }
  const readSettings = () => readFileSync(join(projectDir, SETTINGS), "utf8")

  beforeEach(() => {
    writeFile("mvnw", "")
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
  })

  it("adds the session-start, user-prompt, pre-edit, post-edit, stop, subagent-start and subagent-stop hooks to .claude/settings.json", async () => {
    const { exitCode, stdout, stderr } = await run("init", "--agent", "claude-code")

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
    expect(JSON.parse(readSettings())).toEqual({
      hooks: {
        SessionStart: [{ hooks: [SESSION_START] }],
        UserPromptSubmit: [{ hooks: [USER_PROMPT] }],
        PreToolUse: [{ matcher: "Edit|Write", hooks: [PRE_EDIT] }],
        PostToolUse: [{ matcher: "Edit|Write", hooks: [POST_EDIT] }],
        Stop: [{ hooks: [STOP] }],
        SubagentStart: [{ hooks: [SUBAGENT_START] }],
        SubagentStop: [{ hooks: [SUBAGENT_STOP] }],
      },
    })
    expect(stdout).toContain("Wrote:\n  interlint.yaml\n  .claude/settings.json\n")
  })

  it("keeps the settings and hooks that are already there", async () => {
    const lint = { matcher: "Write", hooks: [{ type: "command", command: "npm run lint" }] }
    const notify = { hooks: [{ type: "command", command: "notify-send done" }] }
    writeFile(
      SETTINGS,
      JSON.stringify({
        permissions: { allow: ["Bash(./mvnw:*)"] },
        env: { MAVEN_OPTS: "-Xmx1g" },
        hooks: { PostToolUse: [lint], Stop: [notify], SessionStart: [notify] },
      }),
    )

    expect((await run("init", "--agent", "claude-code")).exitCode).toBe(0)

    expect(JSON.parse(readSettings())).toEqual({
      permissions: { allow: ["Bash(./mvnw:*)"] },
      env: { MAVEN_OPTS: "-Xmx1g" },
      hooks: {
        PostToolUse: [lint, { matcher: "Edit|Write", hooks: [POST_EDIT] }],
        Stop: [notify, { hooks: [STOP] }],
        SessionStart: [notify, { hooks: [SESSION_START] }],
        UserPromptSubmit: [{ hooks: [USER_PROMPT] }],
        PreToolUse: [{ matcher: "Edit|Write", hooks: [PRE_EDIT] }],
        SubagentStart: [{ hooks: [SUBAGENT_START] }],
        SubagentStop: [{ hooks: [SUBAGENT_STOP] }],
      },
    })
  })

  it("leaves the same result when it runs twice", async () => {
    writeFile(SETTINGS, '{ "permissions": { "allow": [] } }\n')
    await run("init", "--agent", "claude-code")
    const first = readSettings()

    const { exitCode, stdout } = await run("init", "--agent", "claude-code")

    expect(exitCode).toBe(0)
    expect(stdout).toContain("Unchanged:\n  interlint.yaml\n  .claude/settings.json\n")
    expect(readSettings()).toBe(first)
  })

  it("leaves a file that already has the hooks exactly as it is, formatting included", async () => {
    const settings = `{\n    "hooks": {\n        "SessionStart": [{ "hooks": [${JSON.stringify(SESSION_START)}] }],\n        "PreToolUse": [{ "matcher": "Edit|Write", "hooks": [${JSON.stringify(PRE_EDIT)}] }],\n        "Stop": [{ "hooks": [${JSON.stringify(STOP)}] }],\n        "PostToolUse": [{ "matcher": "Edit|Write", "hooks": [${JSON.stringify(POST_EDIT)}] }],\n        "SubagentStart": [{ "hooks": [${JSON.stringify(SUBAGENT_START)}] }],
        "SubagentStop": [{ "hooks": [${JSON.stringify(SUBAGENT_STOP)}] }],\n        "UserPromptSubmit": [{ "hooks": [${JSON.stringify(USER_PROMPT)}] }]\n    }\n}\n`
    writeFile(SETTINGS, settings)

    expect((await run("init", "--agent", "claude-code")).stdout).toContain("Unchanged:\n  .claude/settings.json\n")
    expect(readSettings()).toBe(settings)
  })

  it("replaces an older Interlint hook instead of adding a second one", async () => {
    const other = { type: "command", command: "npm run lint" }
    writeFile(
      SETTINGS,
      JSON.stringify({
        hooks: {
          PostToolUse: [
            { matcher: "Edit", hooks: [other, { type: "command", command: POST_EDIT.command }] },
            { matcher: "Write", hooks: [{ type: "command", command: POST_EDIT.command, timeout: 60 }] },
          ],
          Stop: [{ hooks: [{ ...STOP, timeout: 60 }] }],
        },
      }),
    )

    await run("init", "--agent", "claude-code")

    expect(JSON.parse(readSettings()).hooks).toEqual({
      PostToolUse: [
        { matcher: "Edit", hooks: [other] },
        { matcher: "Edit|Write", hooks: [POST_EDIT] },
      ],
      Stop: [{ hooks: [STOP] }],
      SubagentStart: [{ hooks: [SUBAGENT_START] }],
      SubagentStop: [{ hooks: [SUBAGENT_STOP] }],
      SessionStart: [{ hooks: [SESSION_START] }],
      UserPromptSubmit: [{ hooks: [USER_PROMPT] }],
      PreToolUse: [{ matcher: "Edit|Write", hooks: [PRE_EDIT] }],
    })
  })

  it("writes nothing when .claude/settings.json is not valid JSON", async () => {
    writeFile(SETTINGS, '{ "hooks": { // comments are not JSON\n } }\n')

    const { exitCode, stderr } = await run("init", "--agent", "claude-code")

    expect(exitCode).toBe(2)
    expect(stderr).toContain(".claude/settings.json is not valid JSON")
    expect(existsSync(join(projectDir, "interlint.yaml"))).toBe(false)
    expect(readSettings()).toBe('{ "hooks": { // comments are not JSON\n } }\n')
  })

  it("writes nothing when the hooks in .claude/settings.json are not what Claude Code expects", async () => {
    writeFile(SETTINGS, '{ "hooks": { "Stop": {} } }')

    const { exitCode, stderr } = await run("init", "--agent", "claude-code")

    expect(exitCode).toBe(2)
    expect(stderr).toContain(".claude/settings.json: hooks.Stop is not a list")
    expect(existsSync(join(projectDir, "interlint.yaml"))).toBe(false)
  })

  it("writes the hooks and keeps a different interlint.yaml", async () => {
    writeFile("interlint.yaml", "# The team's own config\n")

    const { exitCode, stdout, stderr } = await run("init", "--agent", "claude-code")

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
    expect(stdout).toContain(
      "Wrote:\n  .claude/settings.json\n\nKept:\n  interlint.yaml (differs from what init would write; rerun with --force to replace it)\n",
    )
    expect(readConfig()).toBe("# The team's own config\n")
    expect(JSON.parse(readSettings()).hooks.Stop).toEqual([{ hooks: [STOP] }])
  })

  it("does not write the settings when there are no ArchUnit tests", async () => {
    rmSync(join(projectDir, "src"), { recursive: true })

    expect((await run("init", "--agent", "claude-code")).exitCode).toBe(2)
    expect(existsSync(join(projectDir, ".claude"))).toBe(false)
  })
})

describe("interlint init --agent copilot", () => {
  const HOOKS_FILE = join(".github", "hooks", "interlint.json")
  const readHooks = () => readFileSync(join(projectDir, HOOKS_FILE), "utf8")
  const HOOKS = {
    version: 1,
    hooks: {
      sessionStart: [{ type: "command", command: "interlint hook copilot session-start", timeoutSec: 30 }],
      userPromptSubmitted: [{ type: "command", command: "interlint hook copilot user-prompt", timeoutSec: 120 }],
      preToolUse: [
        {
          type: "command",
          matcher: "edit|create|str_replace_editor|apply_patch",
          command: "interlint hook copilot pre-edit",
          timeoutSec: 30,
        },
      ],
      postToolUse: [
        {
          type: "command",
          matcher: "edit|create|str_replace_editor|apply_patch",
          command: "interlint hook copilot post-edit",
          timeoutSec: 120,
        },
      ],
      agentStop: [{ type: "command", command: "interlint hook copilot stop", timeoutSec: 600 }],
      subagentStart: [{ type: "command", command: "interlint hook copilot subagent-start", timeoutSec: 30 }],
      subagentStop: [{ type: "command", command: "interlint hook copilot subagent-stop", timeoutSec: 600 }],
    },
  }

  beforeEach(() => {
    writeFile("mvnw", "")
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
  })

  it("writes the session-start, user-prompt, pre-edit, post-edit, stop, subagent-start and subagent-stop hooks to .github/hooks/interlint.json, with time for Maven", async () => {
    const { exitCode, stdout, stderr } = await run("init", "--agent", "copilot")

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
    expect(JSON.parse(readHooks())).toEqual(HOOKS)
    expect(stdout).toContain("Wrote:\n  interlint.yaml\n  .github/hooks/interlint.json\n")
  })

  it("leaves the other files in .github/hooks as they are", async () => {
    const other = '{ "version": 1, "hooks": { "sessionStart": [{ "command": "echo hi" }] } }\n'
    writeFile(join(".github", "hooks", "team.json"), other)

    await run("init", "--agent", "copilot")

    expect(readFileSync(join(projectDir, ".github", "hooks", "team.json"), "utf8")).toBe(other)
    expect(readdirSync(join(projectDir, ".github", "hooks")).sort()).toEqual(["interlint.json", "team.json"])
  })

  it("leaves the same result when it runs twice", async () => {
    await run("init", "--agent", "copilot")
    const first = readHooks()

    const { exitCode, stdout } = await run("init", "--agent", "copilot")

    expect(exitCode).toBe(0)
    expect(stdout).toContain("Unchanged:\n  interlint.yaml\n  .github/hooks/interlint.json\n")
    expect(readHooks()).toBe(first)
  })

  it("updates an older interlint.json", async () => {
    writeFile(HOOKS_FILE, '{ "version": 1, "hooks": { "agentStop": [{ "command": "interlint hook copilot stop" }] } }\n')

    const { exitCode, stdout } = await run("init", "--agent", "copilot")

    expect(exitCode).toBe(0)
    expect(stdout).toContain(".github/hooks/interlint.json")
    expect(JSON.parse(readHooks())).toEqual(HOOKS)
  })
})

describe("interlint init --agent codex", () => {
  const HOOKS_FILE = join(".codex", "hooks.json")
  const readHooks = () => readFileSync(join(projectDir, HOOKS_FILE), "utf8")
  const TRUST_NOTE =
    "Codex runs these hooks only once you trust them: open Codex in this project and approve Interlint's hooks in /hooks."
  const INTERLINT_HOOKS = {
    SessionStart: [{ hooks: [{ type: "command", command: "interlint hook codex session-start", timeout: 30 }] }],
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "interlint hook codex user-prompt", timeout: 120 }] }],
    PostToolUse: [
      {
        matcher: "apply_patch|Edit|Write",
        hooks: [{ type: "command", command: "interlint hook codex post-edit", timeout: 120, statusMessage: "Interlint: running checks" }],
      },
    ],
    Stop: [{ hooks: [{ type: "command", command: "interlint hook codex stop", timeout: 600, statusMessage: "Interlint: running checks" }] }],
    SubagentStop: [{ hooks: [{ type: "command", command: "interlint hook codex subagent-stop", timeout: 600, statusMessage: "Interlint: running checks" }] }],
  }

  beforeEach(() => {
    writeFile("mvnw", "")
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
  })

  it("writes the session-start, user-prompt, post-edit, stop and subagent-stop hooks to .codex/hooks.json, with time for Maven, and says to trust them", async () => {
    const { exitCode, stdout, stderr } = await run("init", "--agent", "codex")

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
    expect(JSON.parse(readHooks())).toEqual({ hooks: INTERLINT_HOOKS })
    expect(stdout).toContain("Wrote:\n  interlint.yaml\n  .codex/hooks.json\n")
    expect(stdout.trimEnd().endsWith(TRUST_NOTE)).toBe(true)
  })

  it("keeps the other hooks of .codex/hooks.json and leaves .codex/config.toml as it is", async () => {
    const team = {
      description: "Team hooks",
      hooks: {
        SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo hi", timeout: 30 }] }],
        Stop: [{ hooks: [{ type: "command", command: "team-telemetry", async: true }] }],
      },
    }
    writeFile(HOOKS_FILE, JSON.stringify(team))
    const config = 'model = "gpt-6-codex"\n\n[hooks]\n'
    writeFile(join(".codex", "config.toml"), config)

    await run("init", "--agent", "codex")

    expect(JSON.parse(readHooks())).toEqual({
      description: "Team hooks",
      hooks: {
        SessionStart: [...team.hooks.SessionStart, ...INTERLINT_HOOKS.SessionStart],
        Stop: [...team.hooks.Stop, ...INTERLINT_HOOKS.Stop],
        UserPromptSubmit: INTERLINT_HOOKS.UserPromptSubmit,
        PostToolUse: INTERLINT_HOOKS.PostToolUse,
        SubagentStop: INTERLINT_HOOKS.SubagentStop,
      },
    })
    expect(readFileSync(join(projectDir, ".codex", "config.toml"), "utf8")).toBe(config)
  })

  it("leaves the file byte for byte as it was when it runs twice, so Codex does not ask to trust the hooks again", async () => {
    await run("init", "--agent", "codex")
    const first = readHooks()

    const { exitCode, stdout } = await run("init", "--agent", "codex")

    expect(exitCode).toBe(0)
    expect(stdout).toContain("Unchanged:\n  interlint.yaml\n  .codex/hooks.json\n")
    expect(stdout).not.toContain(TRUST_NOTE)
    expect(readHooks()).toBe(first)
  })

  it("replaces an older Interlint hook with a different timeout", async () => {
    writeFile(
      HOOKS_FILE,
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "interlint hook codex stop", timeout: 60 }] }] } }),
    )

    const { stdout } = await run("init", "--agent", "codex")

    expect(JSON.parse(readHooks()).hooks.Stop).toEqual(INTERLINT_HOOKS.Stop)
    // A changed hook must be trusted again.
    expect(stdout).toContain(TRUST_NOTE)
  })

  it("replaces an Interlint hook written before the status message, so Codex shows that the checks are running", async () => {
    const { statusMessage: _, ...older } = INTERLINT_HOOKS.Stop[0]!.hooks[0]!
    writeFile(HOOKS_FILE, JSON.stringify({ hooks: { Stop: [{ hooks: [older] }] } }))

    await run("init", "--agent", "codex")

    expect(JSON.parse(readHooks()).hooks.Stop).toEqual(INTERLINT_HOOKS.Stop)
  })

  it("stops with an error and writes nothing when .codex/hooks.json is not JSON", async () => {
    writeFile(HOOKS_FILE, "{ not json")

    const { exitCode, stderr } = await run("init", "--agent", "codex")

    expect(exitCode).toBe(2)
    expect(stderr).toContain(".codex/hooks.json is not valid JSON")
    expect(existsSync(join(projectDir, "interlint.yaml"))).toBe(false)
  })
})

describe("interlint init --agent claude-code with an older hook next to the current one", () => {
  const SETTINGS = join(".claude", "settings.json")
  const POST_EDIT = { type: "command", command: "interlint hook claude-code post-edit", timeout: 120, statusMessage: "Interlint: running checks" }
  const STOP = { type: "command", command: "interlint hook claude-code stop", timeout: 600, statusMessage: "Interlint: running checks" }
  const SUBAGENT_STOP = { type: "command", command: "interlint hook claude-code subagent-stop", timeout: 600, statusMessage: "Interlint: running checks" }
  const SUBAGENT_START = { type: "command", command: "interlint hook claude-code subagent-start", timeout: 30 }
  const SESSION_START = { type: "command", command: "interlint hook claude-code session-start", timeout: 30 }
  const PRE_EDIT = { type: "command", command: "interlint hook claude-code pre-edit", timeout: 30 }
  const USER_PROMPT = { type: "command", command: "interlint hook claude-code user-prompt", timeout: 120 }

  beforeEach(() => {
    writeFile("mvnw", "")
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
  })

  it("replaces the hooks written before the status message, so Claude Code shows that the checks are running", async () => {
    const { statusMessage: _post, ...olderPostEdit } = POST_EDIT
    const { statusMessage: _stop, ...olderStop } = STOP
    writeFile(
      SETTINGS,
      JSON.stringify({
        hooks: { PostToolUse: [{ matcher: "Edit|Write", hooks: [olderPostEdit] }], Stop: [{ hooks: [olderStop] }] },
      }),
    )

    await run("init", "--agent", "claude-code")

    const hooks = JSON.parse(readFileSync(join(projectDir, SETTINGS), "utf8")).hooks
    expect(hooks.PostToolUse).toEqual([{ matcher: "Edit|Write", hooks: [POST_EDIT] }])
    expect(hooks.Stop).toEqual([{ hooks: [STOP] }])
  })

  it("removes the older copy, so each hook runs once", async () => {
    const other = { type: "command", command: "npm run lint" }
    writeFile(
      SETTINGS,
      JSON.stringify({
        hooks: {
          PostToolUse: [
            { matcher: "Edit", hooks: [other, { ...POST_EDIT, timeout: 60 }] },
            { matcher: "Edit|Write", hooks: [POST_EDIT, POST_EDIT] },
          ],
          Stop: [{ hooks: [STOP] }, { hooks: [{ ...STOP, timeout: 30 }] }],
        },
      }),
    )

    expect((await run("init", "--agent", "claude-code")).exitCode).toBe(0)

    expect(JSON.parse(readFileSync(join(projectDir, SETTINGS), "utf8")).hooks).toEqual({
      PostToolUse: [
        { matcher: "Edit", hooks: [other] },
        { matcher: "Edit|Write", hooks: [POST_EDIT] },
      ],
      Stop: [{ hooks: [STOP] }],
      SubagentStart: [{ hooks: [SUBAGENT_START] }],
      SubagentStop: [{ hooks: [SUBAGENT_STOP] }],
      SessionStart: [{ hooks: [SESSION_START] }],
      UserPromptSubmit: [{ hooks: [USER_PROMPT] }],
      PreToolUse: [{ matcher: "Edit|Write", hooks: [PRE_EDIT] }],
    })
  })
})

describe("interlint init with Checkstyle and PMD", () => {
  const plugin = (artifactId: string) =>
    `      <plugin>\n        <groupId>org.apache.maven.plugins</groupId>\n        <artifactId>${artifactId}</artifactId>\n      </plugin>\n`

  function pom({ build = "", rest = "" }: { build?: string; rest?: string }) {
    writeFile(
      "pom.xml",
      `<project>\n  <artifactId>shop</artifactId>\n  <build>\n    <plugins>\n${build}    </plugins>\n  </build>\n${rest}</project>\n`,
    )
  }

  it("adds a checkstyle check for each edit and a pmd check for every 5 edited files or 200 written lines when pom.xml declares both plugins", async () => {
    writeFile("mvnw", "")
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    pom({ build: plugin("maven-checkstyle-plugin") + plugin("maven-pmd-plugin") })

    const { exitCode, stderr } = await run("init")

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
    expect(loadConfig(projectDir).checks).toEqual([
      {
        name: "architecture",
        run: "./mvnw -q test -Dtest=ArchitectureRulesTest -Dcheckstyle.skip -Dpmd.skip",
        report: "archunit",
        when: "edit",
        every: 5, lines: 200,
      },
      { name: "checkstyle", run: "./mvnw -q checkstyle:check", report: "maven", when: "edit" },
      { name: "pmd", run: "./mvnw -q compile pmd:check -Dcheckstyle.skip -Dpmd.analysisCache=true", report: "maven", when: "edit", every: 5, lines: 200 },
    ])
  })

  it("skips in each check the plugins the other checks run, so one failure shows in one check", async () => {
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    pom({ build: plugin("maven-pmd-plugin") })

    await run("init")

    expect(loadConfig(projectDir).checks.map((check) => check.run)).toEqual([
      "mvn -q test -Dtest=ArchitectureRulesTest -Dpmd.skip",
      "mvn -q compile pmd:check -Dcheckstyle.skip -Dpmd.analysisCache=true",
    ])
  })

  it("adds only the check of the plugin it finds, in build or pluginManagement", async () => {
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    writeFile(
      "pom.xml",
      `<project>\n  <build>\n    <pluginManagement>\n      <plugins>\n${plugin("maven-pmd-plugin")}      </plugins>\n    </pluginManagement>\n  </build>\n</project>\n`,
    )

    await run("init")

    expect(loadConfig(projectDir).checks.map((check) => check.name)).toEqual(["architecture", "pmd"])
  })

  it("ignores a plugin that is only in a comment, a profile or the reporting section", async () => {
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    pom({
      build: `      <!--\n${plugin("maven-checkstyle-plugin")}      -->\n`,
      rest: `  <profiles>\n    <profile>\n      <build>\n        <plugins>\n${plugin("maven-checkstyle-plugin")}        </plugins>\n      </build>\n    </profile>\n  </profiles>\n  <reporting>\n    <plugins>\n${plugin("maven-pmd-plugin")}    </plugins>\n  </reporting>\n`,
    })

    await run("init")

    expect(loadConfig(projectDir).checks.map((check) => check.name)).toEqual(["architecture"])
  })

  it("still finds a plugin that pins its own dependencies, before or after its artifactId", async () => {
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    const puppycrawl =
      "        <dependencies>\n          <dependency>\n            <groupId>com.puppycrawl.tools</groupId>\n            <artifactId>checkstyle</artifactId>\n          </dependency>\n        </dependencies>\n"
    pom({
      build:
        `      <plugin>\n        <artifactId>maven-checkstyle-plugin</artifactId>\n${puppycrawl}      </plugin>\n` +
        `      <plugin>\n${puppycrawl}        <artifactId>maven-pmd-plugin</artifactId>\n      </plugin>\n`,
    })

    await run("init")

    expect(loadConfig(projectDir).checks.map((check) => check.name)).toEqual(["architecture", "checkstyle", "pmd"])
  })

  describe("when the build runs check in an <execution>", () => {
    const execution = (inner: string) =>
      `          <execution>\n${inner}            <goals>\n              <goal>check</goal>\n            </goals>\n            <configuration>\n              <violationSeverity>warning</violationSeverity>\n            </configuration>\n          </execution>\n`
    const withExecutions = (artifactId: string, executions: string) =>
      `      <plugin>\n        <artifactId>${artifactId}</artifactId>\n        <executions>\n${executions}        </executions>\n      </plugin>\n`
    const runs = () => loadConfig(projectDir).checks.map((check) => check.run)

    it("runs that execution, so its configuration applies, and calls one without id `default`", async () => {
      pom({
        build:
          withExecutions("maven-checkstyle-plugin", execution("            <id>style</id>\n            <phase>validate</phase>\n")) +
          withExecutions("maven-pmd-plugin", execution("            <phase>verify</phase>\n")),
      })

      await run("init")

      expect(runs()).toEqual(["mvn -q checkstyle:check@style", "mvn -q compile pmd:check@default -Dcheckstyle.skip -Dpmd.analysisCache=true"])
    })

    it("finds the execution in pluginManagement too", async () => {
      writeFile(
        "pom.xml",
        `<project>\n  <build>\n    <pluginManagement>\n      <plugins>\n${withExecutions("maven-checkstyle-plugin", execution("            <id>style</id>\n"))}      </plugins>\n    </pluginManagement>\n  </build>\n</project>\n`,
      )

      await run("init")

      expect(runs()).toEqual(["mvn -q checkstyle:check@style"])
    })

    it("runs the plain goal when the execution that runs check has an id that could mean something to the shell", async () => {
      pom({
        build: withExecutions(
          "maven-checkstyle-plugin",
          execution("            <id>inherited</id>\n            <phase>none</phase>\n") + execution("            <id>a;rm</id>\n"),
        ),
      })

      await run("init")

      expect(runs()).toEqual(["mvn -q checkstyle:check"])
    })

    it("leaves out a plugin whose executions never run check: a report, cpd-check only, or a check turned off", async () => {
      archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
      const goalOnly = (id: string, goal: string) =>
        `          <execution>\n            <id>${id}</id>\n            <goals>\n              <goal>${goal}</goal>\n            </goals>\n          </execution>\n`
      pom({
        build:
          withExecutions("maven-checkstyle-plugin", goalOnly("report", "checkstyle")) +
          withExecutions("maven-pmd-plugin", goalOnly("cpd", "cpd-check")),
      })

      await run("init")

      expect(loadConfig(projectDir).checks.map((check) => check.name)).toEqual(["architecture"])

      pom({ build: withExecutions("maven-pmd-plugin", execution("            <id>inherited</id>\n            <phase>none</phase>\n")) })

      await run("init", "--force")

      expect(loadConfig(projectDir).checks.map((check) => check.name)).toEqual(["architecture"])
    })
  })

  it("ignores a plugin that is only a dependency", async () => {
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    const dependency = (artifactId: string) =>
      `      <dependency>\n        <groupId>org.apache.maven.plugins</groupId>\n        <artifactId>${artifactId}</artifactId>\n      </dependency>\n`
    pom({
      rest: `  <dependencyManagement>\n    <dependencies>\n${dependency("maven-checkstyle-plugin")}    </dependencies>\n  </dependencyManagement>\n  <dependencies>\n${dependency("maven-pmd-plugin")}  </dependencies>\n`,
    })

    await run("init")

    expect(loadConfig(projectDir).checks.map((check) => check.name)).toEqual(["architecture"])
  })

  it("says what it detected", async () => {
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    pom({ build: plugin("maven-checkstyle-plugin") + plugin("maven-pmd-plugin") })
    installMavenDaemon()

    const { stdout } = await run("init")

    expect(stdout).toBe(
      [
        "Detected:",
        "  ArchUnit tests: ArchitectureRulesTest",
        "  Checkstyle: maven-checkstyle-plugin in pom.xml",
        "  PMD: maven-pmd-plugin in pom.xml",
        "  Maven: mvn (no Maven Wrapper)",
        "  mvnd: on the PATH, so the Checkstyle check runs after each edit, and the ArchUnit and PMD checks run after every 5 edited files or 200 written lines",
        "",
        "Wrote:",
        "  interlint.yaml",
        "",
      ].join("\n"),
    )
  })

  it("says every check waits for task end without mvnd", async () => {
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    pom({ build: plugin("maven-checkstyle-plugin") + plugin("maven-pmd-plugin") })

    const { stdout } = await run("init")

    expect(stdout).toContain(
      "  mvnd: not on the PATH, so the ArchUnit, Checkstyle and PMD checks run at task end; install mvnd to run them after edits\n",
    )
  })

  it("writes the Checkstyle check alone when there are no ArchUnit tests", async () => {
    pom({ build: plugin("maven-checkstyle-plugin") })

    const { exitCode, stdout } = await run("init")

    expect(exitCode).toBe(0)
    expect(loadConfig(projectDir).checks).toEqual([
      { name: "checkstyle", run: "mvn -q checkstyle:check", report: "maven", when: "edit" },
    ])
    expect(stdout).toBe(
      [
        "Detected:",
        "  ArchUnit tests: none",
        "  Checkstyle: maven-checkstyle-plugin in pom.xml",
        "  Maven: mvn (no Maven Wrapper)",
        "  mvnd: not on the PATH, so the Checkstyle check runs at task end; install mvnd to run it after each edit",
        "",
        "Wrote:",
        "  interlint.yaml",
        "",
      ].join("\n"),
    )
  })

  it("still writes nothing when there are neither ArchUnit tests nor plugins", async () => {
    pom({})

    const { exitCode, stderr } = await run("init")

    expect(exitCode).toBe(2)
    expect(stderr).toBe(
      "interlint: nothing to check: no file under src/test/java contains @ArchTest, and the build in pom.xml has no maven-checkstyle-plugin, maven-pmd-plugin, spotbugs-maven-plugin or jacoco-maven-plugin check. Nothing was written.\n",
    )
  })
})

describe("interlint init with JaCoCo", () => {
  const execution = (id: string | undefined, goal: string, phase?: string) =>
    `          <execution>\n${id === undefined ? "" : `            <id>${id}</id>\n`}${phase === undefined ? "" : `            <phase>${phase}</phase>\n`}            <goals>\n              <goal>${goal}</goal>\n            </goals>\n          </execution>\n`
  const jacoco = (executions: string) =>
    `      <plugin>\n        <groupId>org.jacoco</groupId>\n        <artifactId>jacoco-maven-plugin</artifactId>\n        <executions>\n${executions}        </executions>\n      </plugin>\n`
  const plugin = (artifactId: string) => `      <plugin>\n        <artifactId>${artifactId}</artifactId>\n      </plugin>\n`

  function pom(build: string) {
    writeFile("pom.xml", `<project>\n  <artifactId>shop</artifactId>\n  <build>\n    <plugins>\n${build}    </plugins>\n  </build>\n</project>\n`)
  }

  it("adds a coverage check for task end only when the build runs the check goal", async () => {
    pom(jacoco(execution("prepare", "prepare-agent") + execution("check", "check")))

    const { exitCode } = await run("init")

    expect(exitCode).toBe(0)
    expect(loadConfig(projectDir).checks).toEqual([
      { name: "coverage", run: "mvn test jacoco:check@check -fae -Djacoco.append=false", report: "jacoco", when: "task-end" },
    ])
  })

  it("skips the Checkstyle and PMD plugins of the build, which their own checks report", async () => {
    writeFile("mvnw", "")
    pom(plugin("maven-checkstyle-plugin") + plugin("maven-pmd-plugin") + jacoco(execution(undefined, "check")))

    await run("init")

    expect(loadConfig(projectDir).checks.map(({ name, run }) => [name, run])).toEqual([
      ["checkstyle", "./mvnw -q checkstyle:check"],
      ["pmd", "./mvnw -q compile pmd:check -Dcheckstyle.skip -Dpmd.analysisCache=true"],
      ["coverage", "./mvnw test jacoco:check@default -fae -Djacoco.append=false -Dcheckstyle.skip -Dpmd.skip"],
    ])
  })

  it("adds none when the build only prepares the agent or writes the report, or turns the check off", async () => {
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    pom(jacoco(execution("prepare", "prepare-agent") + execution("report", "report") + execution("check", "check", "none")))

    await run("init")

    expect(loadConfig(projectDir).checks.map((check) => check.name)).toEqual(["architecture"])
  })

  it("says it detected the check goal, and that the coverage check runs at task end", async () => {
    pom(jacoco(execution("check", "check")))

    const { stdout } = await run("init")

    expect(stdout).toBe(
      [
        "Detected:",
        "  ArchUnit tests: none",
        "  JaCoCo: jacoco-maven-plugin check in pom.xml, so the coverage check runs at task end",
        "  Maven: mvn (no Maven Wrapper)",
        "",
        "Wrote:",
        "  interlint.yaml",
        "",
      ].join("\n"),
    )
  })
})

describe("interlint init with SpotBugs", () => {
  const execution = (id: string | undefined, goal = "check", phase?: string) =>
    `          <execution>\n${id === undefined ? "" : `            <id>${id}</id>\n`}${phase === undefined ? "" : `            <phase>${phase}</phase>\n`}            <goals>\n              <goal>${goal}</goal>\n            </goals>\n          </execution>\n`
  const spotbugs = (executions: string) =>
    `      <plugin>\n        <groupId>com.github.spotbugs</groupId>\n        <artifactId>spotbugs-maven-plugin</artifactId>\n        <configuration>\n          <threshold>Low</threshold>\n        </configuration>\n        <executions>\n${executions}        </executions>\n      </plugin>\n`
  const plugin = (artifactId: string) => `      <plugin>\n        <artifactId>${artifactId}</artifactId>\n      </plugin>\n`
  const jacoco = `      <plugin>\n        <artifactId>jacoco-maven-plugin</artifactId>\n        <executions>\n${execution("check")}        </executions>\n      </plugin>\n`

  function pom(build: string) {
    writeFile("pom.xml", `<project>\n  <artifactId>shop</artifactId>\n  <build>\n    <plugins>\n${build}    </plugins>\n  </build>\n</project>\n`)
  }

  it("keeps OpenAPI Generator from regenerating an unchanged spec in the spotbugs check of a project without modules", async () => {
    pom(spotbugs(execution("spotbugs")) + plugin("openapi-generator-maven-plugin"))

    await run("init")

    expect(loadConfig(projectDir).checks.map((check) => check.run)).toEqual([
      "mvn -q compile spotbugs:check@spotbugs -Dcheckstyle.skip -Dpmd.skip -Dcodegen.skipIfSpecIsUnchanged=true",
    ])
  })

  it("counts OpenAPI Generator that a project without modules only manages in pluginManagement", async () => {
    writeFile(
      "pom.xml",
      `<project>\n  <build>\n    <pluginManagement>\n      <plugins>\n${plugin("openapi-generator-maven-plugin")}      </plugins>\n    </pluginManagement>\n    <plugins>\n${spotbugs(execution("spotbugs"))}    </plugins>\n  </build>\n</project>\n`,
    )

    await run("init")

    expect(loadConfig(projectDir).checks.map((check) => check.run)).toEqual([
      "mvn -q compile spotbugs:check@spotbugs -Dcheckstyle.skip -Dpmd.skip -Dcodegen.skipIfSpecIsUnchanged=true",
    ])
  })

  it("adds a spotbugs check that compiles first and skips Checkstyle and PMD, and the other checks skip SpotBugs", async () => {
    writeFile("mvnw", "")
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    pom(plugin("maven-checkstyle-plugin") + plugin("maven-pmd-plugin") + spotbugs(execution("spotbugs")) + jacoco)

    const { exitCode, stderr } = await run("init")

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
    expect(loadConfig(projectDir).checks).toEqual([
      {
        name: "architecture",
        run: "./mvnw -q test -Dtest=ArchitectureRulesTest -Dcheckstyle.skip -Dpmd.skip -Dspotbugs.skip",
        report: "archunit",
        when: "edit",
        every: 5,
        lines: 200,
      },
      { name: "checkstyle", run: "./mvnw -q checkstyle:check", report: "maven", when: "edit" },
      {
        name: "pmd",
        run: "./mvnw -q compile pmd:check -Dcheckstyle.skip -Dspotbugs.skip -Dpmd.analysisCache=true",
        report: "maven",
        when: "edit",
        every: 5,
        lines: 200,
      },
      {
        name: "spotbugs",
        run: "./mvnw -q compile spotbugs:check@spotbugs -Dcheckstyle.skip -Dpmd.skip",
        report: "maven",
        when: "edit",
        every: 5,
        lines: 200,
      },
      {
        name: "coverage",
        run: "./mvnw test jacoco:check@check -fae -Djacoco.append=false -Dcheckstyle.skip -Dpmd.skip -Dspotbugs.skip",
        report: "jacoco",
        when: "task-end",
      },
    ])
  })

  it("finds the check execution of a plugin that adds SpotBugs plugins, such as Find Security Bugs, in its configuration", async () => {
    const findSecBugs =
      "      <plugin>\n        <artifactId>spotbugs-maven-plugin</artifactId>\n        <configuration>\n          <plugins>\n            <plugin>\n              <groupId>com.h3xstream.findsecbugs</groupId>\n              <artifactId>findsecbugs-plugin</artifactId>\n            </plugin>\n          </plugins>\n        </configuration>\n        <executions>\n" +
      execution("spotbugs") +
      "        </executions>\n      </plugin>\n"
    pom(findSecBugs)

    await run("init")

    expect(loadConfig(projectDir).checks.map((check) => check.run)).toEqual([
      "mvn -q compile spotbugs:check@spotbugs -Dcheckstyle.skip -Dpmd.skip",
    ])
  })

  it("calls an execution without id `default`", async () => {
    pom(spotbugs(execution(undefined)))

    await run("init")

    expect(loadConfig(projectDir).checks.map((check) => check.run)).toEqual([
      "mvn -q compile spotbugs:check@default -Dcheckstyle.skip -Dpmd.skip",
    ])
  })

  it("adds none when no execution runs check, or the one that does is turned off, and the other checks stay as they were", async () => {
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    pom(plugin("maven-pmd-plugin") + spotbugs(execution("analyze", "spotbugs") + execution("inherited", "check", "none")))

    await run("init")

    expect(loadConfig(projectDir).checks.map((check) => check.run)).toEqual([
      "mvn -q test -Dtest=ArchitectureRulesTest -Dpmd.skip",
      "mvn -q compile pmd:check -Dcheckstyle.skip -Dpmd.analysisCache=true",
    ])
  })

  it("says what it detected", async () => {
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    pom(plugin("maven-checkstyle-plugin") + spotbugs(execution("spotbugs")))
    installMavenDaemon()

    const { stdout } = await run("init")

    expect(stdout).toBe(
      [
        "Detected:",
        "  ArchUnit tests: ArchitectureRulesTest",
        "  Checkstyle: maven-checkstyle-plugin in pom.xml",
        "  SpotBugs: spotbugs-maven-plugin check in pom.xml",
        "  Maven: mvn (no Maven Wrapper)",
        "  mvnd: on the PATH, so the Checkstyle check runs after each edit, and the ArchUnit and SpotBugs checks run after every 5 edited files or 200 written lines",
        "",
        "Wrote:",
        "  interlint.yaml",
        "",
      ].join("\n"),
    )
  })

  it("says what it looks for when it finds nothing to check", async () => {
    pom(spotbugs(execution("analyze", "spotbugs")))

    const { exitCode, stderr } = await run("init")

    expect(exitCode).toBe(2)
    expect(stderr).toBe(
      "interlint: nothing to check: no file under src/test/java contains @ArchTest, and the build in pom.xml has no maven-checkstyle-plugin, maven-pmd-plugin, spotbugs-maven-plugin or jacoco-maven-plugin check. Nothing was written.\n",
    )
  })
})

describe("interlint init in a multi-module project", () => {
  const managed =(artifactId: string, executionId: string) =>
    `        <plugin>\n          <artifactId>${artifactId}</artifactId>\n          <executions>\n            <execution>\n              <id>${executionId}</id>\n              <goals>\n                <goal>check</goal>\n              </goals>\n            </execution>\n          </executions>\n        </plugin>\n`
  const activated = (artifactId: string) => `      <plugin>\n        <artifactId>${artifactId}</artifactId>\n      </plugin>\n`

  /** A parent POM that manages plugins for its modules, and a POM per module that turns some of them on. */
  function reactor(dir: string, options: { managed: string[]; modules: Record<string, string[]>; wrapper?: boolean }) {
    const at = (path: string) => (dir === "" ? path : `${dir}/${path}`)
    const modules = Object.keys(options.modules)
    writeFile(
      at("pom.xml"),
      `<project>\n  <packaging>pom</packaging>\n  <modules>\n${modules.map((module) => `    <module>${module}</module>\n`).join("")}  </modules>\n  <build>\n    <pluginManagement>\n      <plugins>\n${options.managed.join("")}      </plugins>\n    </pluginManagement>\n  </build>\n</project>\n`,
    )
    for (const [module, plugins] of Object.entries(options.modules)) {
      writeFile(at(`${module}/pom.xml`), `<project>\n  <build>\n    <plugins>\n${plugins.map(activated).join("")}    </plugins>\n  </build>\n</project>\n`)
    }
    if (options.wrapper !== false) writeFile(at("mvnw"), "")
  }

  const BOTH = ["maven-checkstyle-plugin", "maven-pmd-plugin"]
  const MANAGED_BOTH = [managed("maven-checkstyle-plugin", "style"), managed("maven-pmd-plugin", "pmd")]

  it("runs the coverage rules the parent manages when a module turns JaCoCo on, and none when no module does", async () => {
    reactor("", { managed: [managed("jacoco-maven-plugin", "check")], modules: { domain: ["jacoco-maven-plugin"], launcher: [] } })

    expect((await run("init")).exitCode).toBe(0)
    expect(loadConfig(projectDir).checks).toEqual([
      { name: "coverage", run: "./mvnw test jacoco:check@check -fae -Djacoco.append=false", report: "jacoco", when: "task-end" },
    ])

    reactor("", { managed: [managed("jacoco-maven-plugin", "check")], modules: { domain: [], launcher: [] } })

    expect((await run("init", "--force")).exitCode).toBe(2)
  })

  it("keeps OpenAPI Generator from regenerating an unchanged spec in the checks that compile, when a module runs it", async () => {
    reactor("", {
      managed: [...MANAGED_BOTH, managed("jacoco-maven-plugin", "check")],
      modules: { spec: ["openapi-generator-maven-plugin"], launcher: [...BOTH, "jacoco-maven-plugin"] },
    })
    archTest("launcher/src/test/java/com/acme/ArchitectureRulesTest.java")

    expect((await run("init")).exitCode).toBe(0)

    expect(loadConfig(projectDir).checks.map((check) => check.run)).toEqual([
      "./mvnw -q test -pl launcher -am -Dtest=ArchitectureRulesTest -Dsurefire.failIfNoSpecifiedTests=false -Dcheckstyle.skip -Dpmd.skip -Dcodegen.skipIfSpecIsUnchanged=true",
      "./mvnw -q -fn checkstyle:check@style",
      "./mvnw -q -fn compile pmd:check@pmd -Dcheckstyle.skip -Dpmd.analysisCache=true -Dcodegen.skipIfSpecIsUnchanged=true",
      "./mvnw test jacoco:check@check -fae -Djacoco.append=false -Dcheckstyle.skip -Dpmd.skip -Dcodegen.skipIfSpecIsUnchanged=true",
    ])
  })

  it("leaves OpenAPI Generator alone when the parent only manages it and no module runs it", async () => {
    reactor("", { managed: [managed("maven-pmd-plugin", "pmd"), managed("openapi-generator-maven-plugin", "gen")], modules: { domain: ["maven-pmd-plugin"] } })

    expect((await run("init")).exitCode).toBe(0)

    expect(loadConfig(projectDir).checks.map((check) => check.run)).toEqual([
      "./mvnw -q -fn compile pmd:check@pmd -Dcheckstyle.skip -Dpmd.analysisCache=true",
    ])
  })

  it("finds the @ArchTest classes of a module and runs only that module and the ones it depends on", async () => {
    reactor("", { managed: MANAGED_BOTH, modules: { domain: BOTH, "adapters/rest": BOTH, launcher: BOTH } })
    archTest("launcher/src/test/java/com/acme/ArchitectureRulesTest.java")

    expect((await run("init")).exitCode).toBe(0)

    expect(loadConfig(projectDir).checks).toEqual([
      {
        name: "architecture",
        run: "./mvnw -q test -pl launcher -am -Dtest=ArchitectureRulesTest -Dsurefire.failIfNoSpecifiedTests=false -Dcheckstyle.skip -Dpmd.skip",
        report: "archunit",
        when: "edit",
        every: 5, lines: 200,
      },
      { name: "checkstyle", run: "./mvnw -q -fn checkstyle:check@style", report: "maven", when: "edit" },
      { name: "pmd", run: "./mvnw -q -fn compile pmd:check@pmd -Dcheckstyle.skip -Dpmd.analysisCache=true", report: "maven", when: "edit", every: 5, lines: 200 },
    ])
  })

  it("names every module that has @ArchTest classes", async () => {
    reactor("", { managed: [], modules: { domain: [], "adapters/rest": [], launcher: [] } })
    archTest("launcher/src/test/java/com/acme/LauncherRulesTest.java")
    archTest("adapters/rest/src/test/java/com/acme/RestRulesTest.java")

    await run("init")

    expect(loadConfig(projectDir).checks[0]?.run).toBe(
      "./mvnw -q test -pl adapters/rest,launcher -am -Dtest=LauncherRulesTest,RestRulesTest -Dsurefire.failIfNoSpecifiedTests=false",
    )
  })

  it("leaves out a plugin that only pluginManagement declares and no module turns on", async () => {
    reactor("", { managed: MANAGED_BOTH, modules: { domain: ["maven-checkstyle-plugin"], launcher: [] } })

    await run("init")

    expect(loadConfig(projectDir).checks.map((check) => check.name)).toEqual(["checkstyle"])
  })

  it("runs the SpotBugs execution the parent manages when a module turns SpotBugs on, and none when no module does", async () => {
    reactor("", { managed: [managed("spotbugs-maven-plugin", "spotbugs")], modules: { domain: ["spotbugs-maven-plugin"], launcher: [] } })

    expect((await run("init")).exitCode).toBe(0)
    expect(loadConfig(projectDir).checks.map(({ name, run }) => [name, run])).toEqual([
      ["spotbugs", "./mvnw -q -fn compile spotbugs:check@spotbugs -Dcheckstyle.skip -Dpmd.skip"],
    ])

    reactor("", { managed: [managed("spotbugs-maven-plugin", "spotbugs")], modules: { domain: [], launcher: [] } })

    expect((await run("init", "--force")).exitCode).toBe(2)
  })

  it("leaves out a plugin a module turns on when the parent's executions of it only write a report", async () => {
    const reportOnly =
      "        <plugin>\n          <artifactId>maven-checkstyle-plugin</artifactId>\n          <executions>\n            <execution>\n              <id>report</id>\n              <goals>\n                <goal>checkstyle</goal>\n              </goals>\n            </execution>\n          </executions>\n        </plugin>\n"
    reactor("", { managed: [reportOnly, managed("maven-pmd-plugin", "pmd")], modules: { domain: BOTH } })

    await run("init")

    expect(loadConfig(projectDir).checks.map((check) => check.name)).toEqual(["pmd"])
  })

  it("counts a plugin a module turns on without the parent managing it", async () => {
    reactor("", { managed: [], modules: { domain: ["maven-pmd-plugin"] } })

    await run("init")

    expect(loadConfig(projectDir).checks.map((check) => check.run)).toEqual(["./mvnw -q -fn compile pmd:check -Dcheckstyle.skip -Dpmd.analysisCache=true"])
  })

  describe("from the root of a workspace without pom.xml", () => {
    beforeEach(() => {
      reactor("orders", { managed: MANAGED_BOTH, modules: { domain: BOTH, launcher: BOTH } })
      archTest("orders/launcher/src/test/java/com/acme/OrdersRulesTest.java")
      reactor("apps/billing", { managed: MANAGED_BOTH, modules: { core: ["maven-checkstyle-plugin"] }, wrapper: false })
      writeFile("web/package.json", "{}")
      writeFile("web/src/App.java", "class App {}")
      writeFile("docs/README.md", "# Docs")
    })

    it("writes the checks of every Maven project, run in its directory and named after it", async () => {
      expect((await run("init")).exitCode).toBe(0)

      expect(loadConfig(projectDir).checks).toEqual([
        { name: "apps/billing/checkstyle", dir: "apps/billing", run: "mvn -q -fn checkstyle:check@style", report: "maven", when: "edit" },
        {
          name: "orders/architecture",
          dir: "orders",
          run: "./mvnw -q test -pl launcher -am -Dtest=OrdersRulesTest -Dsurefire.failIfNoSpecifiedTests=false -Dcheckstyle.skip -Dpmd.skip",
          report: "archunit",
          when: "edit",
          every: 5, lines: 200,
        },
        { name: "orders/checkstyle", dir: "orders", run: "./mvnw -q -fn checkstyle:check@style", report: "maven", when: "edit" },
        { name: "orders/pmd", dir: "orders", run: "./mvnw -q -fn compile pmd:check@pmd -Dcheckstyle.skip -Dpmd.analysisCache=true", report: "maven", when: "edit", every: 5, lines: 200 },
      ])
      expect(readConfig()).toContain("  - name: orders/architecture\n    dir: orders\n    run: ")
      expect(readConfig()).toContain("    report: archunit\n    when: edit\n    every: 5\n    lines: 200\n")
    })

    it("lists each project with what it detected", async () => {
      writeFile("legacy/pom.xml", "<project/>")
      installMavenDaemon()

      const { stdout } = await run("init")

      expect(stdout).toBe(
        [
          "Detected 3 Maven projects:",
          "  apps/billing",
          "    ArchUnit tests: none",
          "    Checkstyle: maven-checkstyle-plugin in pom.xml",
          "    Maven: mvn (no Maven Wrapper)",
          "  legacy",
          "    nothing to check",
          "  orders",
          "    ArchUnit tests: OrdersRulesTest (in launcher)",
          "    Checkstyle: maven-checkstyle-plugin in pom.xml",
          "    PMD: maven-pmd-plugin in pom.xml",
          "    Maven: ./mvnw (Maven Wrapper)",
          "  mvnd: on the PATH, so the Checkstyle checks run after each edit, and the ArchUnit and PMD checks run after every 5 edited files or 200 written lines",
          "",
          "Wrote:",
          "  interlint.yaml",
          "",
        ].join("\n"),
      )
    })
  })

  it("treats the root as the project, as before, when the workspace holds no Maven project", async () => {
    writeFile("web/package.json", "{}")

    expect(await run("init")).toEqual({
      exitCode: 2,
      stdout: "",
      stderr:
        "interlint: nothing to check: no pom.xml was found here or up to three levels below. No npm project with ESLint or dependency-cruiser (eslint in package.json and an eslint.config file, or dependency-cruiser in package.json and a .dependency-cruiser file) was found either. Nothing was written.\n",
    })
    expect(existsSync(join(projectDir, "interlint.yaml"))).toBe(false)
  })

  it("says so and writes nothing when no Maven project of the workspace has anything to check", async () => {
    writeFile("orders/pom.xml", "<project/>")

    expect(await run("init")).toEqual({
      exitCode: 2,
      stdout: "",
      stderr:
        "interlint: nothing to check: no Maven project has a file under src/test/java with @ArchTest, or maven-checkstyle-plugin, maven-pmd-plugin, a spotbugs-maven-plugin check or a jacoco-maven-plugin check in its build (found: orders). No npm project with ESLint or dependency-cruiser (eslint in package.json and an eslint.config file, or dependency-cruiser in package.json and a .dependency-cruiser file) was found either. Nothing was written.\n",
    })
  })
})

describe("interlint init with ESLint", () => {
  const ESLINT_RUN = "npx --no -- eslint -f json -o node_modules/.cache/interlint/eslint.json ."
  const CHECKSTYLE_POM =
    "<project>\n  <build>\n    <plugins>\n      <plugin>\n        <artifactId>maven-checkstyle-plugin</artifactId>\n      </plugin>\n    </plugins>\n  </build>\n</project>\n"

  /** An npm project that lists ESLint and has a flat configuration, in `dir` (`""` is the root). */
  function eslintProject(dir: string, config = "eslint.config.js") {
    const at = (path: string) => (dir === "" ? path : `${dir}/${path}`)
    writeFile(at("package.json"), JSON.stringify({ name: "web", devDependencies: { eslint: "^10.0.0", typescript: "^5.6.0" } }))
    writeFile(at(config), "export default []\n")
  }

  it("writes an eslint check that runs the project's ESLint after each edit", async () => {
    eslintProject("")

    const { exitCode, stdout } = await run("init")

    expect(exitCode).toBe(0)
    expect(loadConfig(projectDir).checks).toEqual([{ name: "eslint", run: ESLINT_RUN, report: "eslint", when: "edit" }])
    expect(stdout).toBe(
      [
        "Detected:",
        "  ESLint: eslint in package.json and eslint.config.js, so the eslint check runs after each edit",
        "",
        "Wrote:",
        "  interlint.yaml",
        "",
      ].join("\n"),
    )
  })

  it.each([["eslint.config.mjs"], ["eslint.config.cjs"], ["eslint.config.ts"], ["eslint.config.mts"], ["eslint.config.cts"]])(
    "finds the flat configuration in %s",
    async (config) => {
      eslintProject("", config)

      expect((await run("init")).stdout).toContain(`  ESLint: eslint in package.json and ${config}, so`)
    },
  )

  it("finds ESLint among the dependencies too", async () => {
    writeFile("package.json", JSON.stringify({ dependencies: { eslint: "^10.0.0" } }))
    writeFile("eslint.config.js", "export default []\n")

    expect((await run("init")).exitCode).toBe(0)
  })

  it.each([
    ["package.json does not list eslint", () => (writeFile("package.json", '{"devDependencies":{"typescript":"^5.6.0"}}'), writeFile("eslint.config.js", ""))],
    ["there is no package.json", () => writeFile("eslint.config.js", "")],
    ["the configuration is the older .eslintrc", () => (writeFile("package.json", '{"devDependencies":{"eslint":"^8.57.0"}}'), writeFile(".eslintrc.json", "{}"))],
  ])("writes nothing when %s", async (_case, arrange) => {
    arrange()

    expect(await run("init")).toEqual({
      exitCode: 2,
      stdout: "",
      stderr:
        "interlint: nothing to check: no pom.xml was found here or up to three levels below. No npm project with ESLint or dependency-cruiser (eslint in package.json and an eslint.config file, or dependency-cruiser in package.json and a .dependency-cruiser file) was found either. Nothing was written.\n",
    })
    expect(existsSync(join(projectDir, "interlint.yaml"))).toBe(false)
  })

  it("installs the agent's files for a project with only an eslint check", async () => {
    eslintProject("")

    expect((await run("init", "--agent", "opencode")).exitCode).toBe(0)
    expect(existsSync(join(projectDir, PLUGIN_COPY))).toBe(true)
  })

  describe("in a workspace with a Maven project and an npm project", () => {
    beforeEach(() => {
      writeFile("api/pom.xml", CHECKSTYLE_POM)
      eslintProject("web")
      writeFile("web/node_modules/dep/package.json", JSON.stringify({ devDependencies: { eslint: "^10.0.0" } }))
      writeFile("web/node_modules/dep/eslint.config.js", "")
      writeFile("docs/package.json", "{}")
    })

    it("writes the checks of both, each in its directory", async () => {
      expect((await run("init")).exitCode).toBe(0)

      expect(loadConfig(projectDir).checks).toEqual([
        { name: "api/checkstyle", dir: "api", run: "mvn -q checkstyle:check", report: "maven", when: "edit" },
        { name: "web/eslint", dir: "web", run: ESLINT_RUN, report: "eslint", when: "edit" },
      ])
    })

    it("lists each project with what it detected", async () => {
      installMavenDaemon()

      expect((await run("init")).stdout).toBe(
        [
          "Detected 2 projects:",
          "  api",
          "    ArchUnit tests: none",
          "    Checkstyle: maven-checkstyle-plugin in pom.xml",
          "    Maven: mvn (no Maven Wrapper)",
          "  web",
          "    ESLint: eslint in package.json and eslint.config.js, so the eslint check runs after each edit",
          "  mvnd: on the PATH, so the Checkstyle checks run after each edit",
          "",
          "Wrote:",
          "  interlint.yaml",
          "",
        ].join("\n"),
      )
    })

    it("runs only the eslint check for an edit in the npm project", async () => {
      await run("init")
      writeFile("web/src/app.ts", "export const a = 1\n")

      // PATH holds no npx here, so the command fails whatever is installed, and the output names it.
      const { exitCode, stdout, stderr } = await run("check", "--when", "edit", "--file", "web/src/app.ts")

      expect(exitCode).toBe(1)
      expect(stdout + stderr).toContain("✗ web/eslint · the command failed")
      expect(stdout + stderr).toContain(`  Command: ${ESLINT_RUN.slice(0, -1)}--no-warn-ignored src/app.ts`)
      expect(stdout + stderr).not.toContain("api/checkstyle")
    })
  })

  it("writes the eslint checks of the npm projects alone when no directory is a Maven project", async () => {
    eslintProject("apps/web")
    eslintProject("apps/admin")

    const { stdout } = await run("init")

    expect(loadConfig(projectDir).checks.map(({ name, dir }) => [name, dir])).toEqual([
      ["apps/admin/eslint", "apps/admin"],
      ["apps/web/eslint", "apps/web"],
    ])
    expect(stdout).toContain("Detected 2 projects:\n  apps/admin\n")
    expect(stdout).not.toContain("mvnd")
  })

  it("leaves a Maven project as it is when it also holds an npm project with ESLint", async () => {
    writeFile("pom.xml", CHECKSTYLE_POM)
    eslintProject("")
    eslintProject("frontend")

    const { stdout } = await run("init")

    expect(loadConfig(projectDir).checks).toEqual([{ name: "checkstyle", run: "mvn -q checkstyle:check", report: "maven", when: "edit" }])
    expect(stdout).not.toContain("ESLint")
  })

  it("does not say it looked for an npm project in a Maven project with nothing to check", async () => {
    writeFile("pom.xml", "<project/>")
    eslintProject("")

    expect((await run("init")).stderr).toBe(
      "interlint: nothing to check: no file under src/test/java contains @ArchTest, and the build in pom.xml has no maven-checkstyle-plugin, maven-pmd-plugin, spotbugs-maven-plugin or jacoco-maven-plugin check. Nothing was written.\n",
    )
  })

  it("never looks for an npm project in dist, build or coverage", async () => {
    eslintProject("dist")
    eslintProject("packages/ui/build")
    eslintProject("coverage")

    expect(await run("init")).toEqual({
      exitCode: 2,
      stdout: "",
      stderr:
        "interlint: nothing to check: no pom.xml was found here or up to three levels below. No npm project with ESLint or dependency-cruiser (eslint in package.json and an eslint.config file, or dependency-cruiser in package.json and a .dependency-cruiser file) was found either. Nothing was written.\n",
    })

    eslintProject("packages/web")

    expect((await run("init")).exitCode).toBe(0)
    expect(loadConfig(projectDir).checks.map(({ name }) => name)).toEqual(["packages/web/eslint"])
  })

  it("looks for an npm project up to three levels down, and never in a hidden directory", async () => {
    eslintProject("a/b/c/d")
    eslintProject(".tools/web")

    expect((await run("init")).exitCode).toBe(2)

    eslintProject("a/b/c")

    expect((await run("init")).exitCode).toBe(0)
    expect(loadConfig(projectDir).checks.map(({ name }) => name)).toEqual(["a/b/c/eslint"])
  })

  it("orders the projects by code unit, the same on every machine", async () => {
    eslintProject("Zeta")
    eslintProject("alpha")
    writeFile("beta/pom.xml", CHECKSTYLE_POM)

    await run("init")

    expect(loadConfig(projectDir).checks.map(({ dir }) => dir)).toEqual(["Zeta", "alpha", "beta"])
  })

  it("finds no npm project inside a Maven project of a workspace", async () => {
    writeFile("api/pom.xml", CHECKSTYLE_POM)
    eslintProject("api/frontend")

    expect((await run("init")).exitCode).toBe(0)
    expect(loadConfig(projectDir).checks.map(({ name }) => name)).toEqual(["api/checkstyle"])
  })

  it("writes the Maven checks of the projects below an npm project at the root", async () => {
    eslintProject("")
    writeFile("api/pom.xml", CHECKSTYLE_POM)

    installMavenDaemon()

    const { stdout } = await run("init")

    expect(loadConfig(projectDir).checks.map(({ name, dir }) => [name, dir])).toEqual([
      ["eslint", undefined],
      ["api/checkstyle", "api"],
    ])
    expect(stdout).toBe(
      [
        "Detected 2 projects:",
        "  .",
        "    ESLint: eslint in package.json and eslint.config.js, so the eslint check runs after each edit",
        "  api",
        "    ArchUnit tests: none",
        "    Checkstyle: maven-checkstyle-plugin in pom.xml",
        "    Maven: mvn (no Maven Wrapper)",
        "  mvnd: on the PATH, so the Checkstyle checks run after each edit",
        "",
        "Wrote:",
        "  interlint.yaml",
        "",
      ].join("\n"),
    )
  })

  it("names a package.json it cannot read next to an ESLint configuration", async () => {
    writeFile("package.json", "{")
    writeFile("eslint.config.js", "")
    writeFile("apps/web/package.json", "not json")
    writeFile("apps/web/eslint.config.mjs", "")
    writeFile("docs/package.json", "{")

    expect(await run("init")).toEqual({
      exitCode: 2,
      stdout: "",
      stderr:
        "interlint: nothing to check: no pom.xml was found here or up to three levels below. No npm project with ESLint or dependency-cruiser (eslint in package.json and an eslint.config file, or dependency-cruiser in package.json and a .dependency-cruiser file) was found either: package.json and apps/web/package.json are not valid JSON. Nothing was written.\n",
    })
  })

  it("still writes the checks of the other projects next to a package.json it cannot read", async () => {
    eslintProject("web")
    writeFile("admin/package.json", "{")
    writeFile("admin/eslint.config.js", "")

    expect((await run("init")).exitCode).toBe(0)
    expect(loadConfig(projectDir).checks.map(({ name }) => name)).toEqual(["web/eslint"])
  })
})

describe("interlint init with dependency-cruiser", () => {
  const DEPCRUISE_RUN = "npx --no -- depcruise . -T json --output-to node_modules/.cache/interlint/depcruise.json"
  const ESLINT_RUN = "npx --no -- eslint -f json -o node_modules/.cache/interlint/eslint.json ."
  const NOTHING_TO_CHECK =
    "interlint: nothing to check: no pom.xml was found here or up to three levels below. No npm project with ESLint or dependency-cruiser (eslint in package.json and an eslint.config file, or dependency-cruiser in package.json and a .dependency-cruiser file) was found either. Nothing was written.\n"

  /** An npm project that lists dependency-cruiser and has its configuration, in `dir` (`""` is the root). */
  function depcruiseProject(dir: string, config = ".dependency-cruiser.cjs", devDependencies: Record<string, string> = {}) {
    const at = (path: string) => (dir === "" ? path : `${dir}/${path}`)
    writeFile(
      at("package.json"),
      JSON.stringify({ name: "web", devDependencies: { "dependency-cruiser": "^18.7.0", typescript: "^5.9.0", ...devDependencies } }),
    )
    writeFile(at(config), "module.exports = { forbidden: [] }\n")
  }

  it("writes a depcruise check that runs the project's dependency-cruiser after each edit", async () => {
    depcruiseProject("")

    const { exitCode, stdout } = await run("init")

    expect(exitCode).toBe(0)
    expect(loadConfig(projectDir).checks).toEqual([{ name: "depcruise", run: DEPCRUISE_RUN, report: "depcruise", when: "edit" }])
    expect(stdout).toBe(
      [
        "Detected:",
        "  dependency-cruiser: dependency-cruiser in package.json and .dependency-cruiser.cjs, so the depcruise check runs after each edit",
        "",
        "Wrote:",
        "  interlint.yaml",
        "",
      ].join("\n"),
    )
  })

  it.each([
    [".dependency-cruiser.js"],
    [".dependency-cruiser.mjs"],
    [".dependency-cruiser.ts"],
    [".dependency-cruiser.cts"],
    [".dependency-cruiser.mts"],
    [".dependency-cruiser.json"],
  ])("finds the configuration in %s", async (config) => {
    depcruiseProject("", config)

    expect((await run("init")).stdout).toContain(`  dependency-cruiser: dependency-cruiser in package.json and ${config}, so`)
  })

  it("writes the eslint and depcruise checks of a project with both", async () => {
    depcruiseProject("web", ".dependency-cruiser.cjs", { eslint: "^10.0.0" })
    writeFile("web/eslint.config.js", "export default []\n")

    const { exitCode, stdout } = await run("init")

    expect(exitCode).toBe(0)
    expect(loadConfig(projectDir).checks).toEqual([
      { name: "web/eslint", dir: "web", run: ESLINT_RUN, report: "eslint", when: "edit" },
      { name: "web/depcruise", dir: "web", run: DEPCRUISE_RUN, report: "depcruise", when: "edit" },
    ])
    expect(stdout).toContain(
      [
        "  web",
        "    ESLint: eslint in package.json and eslint.config.js, so the eslint check runs after each edit",
        "    dependency-cruiser: dependency-cruiser in package.json and .dependency-cruiser.cjs, so the depcruise check runs after each edit",
      ].join("\n"),
    )
  })

  it.each([
    [
      "package.json does not list dependency-cruiser",
      () => (writeFile("package.json", '{"devDependencies":{"typescript":"^5.9.0"}}'), writeFile(".dependency-cruiser.cjs", "")),
    ],
    ["there is no configuration", () => writeFile("package.json", '{"devDependencies":{"dependency-cruiser":"^18.7.0"}}')],
    ["there is no package.json", () => writeFile(".dependency-cruiser.cjs", "")],
  ])("writes nothing when %s", async (_case, arrange) => {
    arrange()

    expect(await run("init")).toEqual({ exitCode: 2, stdout: "", stderr: NOTHING_TO_CHECK })
    expect(existsSync(join(projectDir, "interlint.yaml"))).toBe(false)
  })

  it("still writes the eslint checks of the packages below a root with dependency-cruiser alone", async () => {
    depcruiseProject("")
    writeFile("packages/web/package.json", JSON.stringify({ devDependencies: { eslint: "^10.0.0" } }))
    writeFile("packages/web/eslint.config.js", "export default []\n")
    depcruiseProject("packages/admin", ".dependency-cruiser.cjs", { eslint: "^10.0.0" })
    writeFile("packages/admin/eslint.config.js", "export default []\n")

    expect((await run("init")).exitCode).toBe(0)
    // The root's dependency-cruiser analyzes the packages too, so a package gets no depcruise check of its own.
    expect(loadConfig(projectDir).checks).toEqual([
      { name: "depcruise", run: DEPCRUISE_RUN, report: "depcruise", when: "edit" },
      { name: "packages/admin/eslint", dir: "packages/admin", run: ESLINT_RUN, report: "eslint", when: "edit" },
      { name: "packages/web/eslint", dir: "packages/web", run: ESLINT_RUN, report: "eslint", when: "edit" },
    ])
  })

  it("names a package.json it cannot read next to a dependency-cruiser configuration", async () => {
    writeFile("package.json", "{")
    writeFile(".dependency-cruiser.cjs", "")

    expect((await run("init")).stderr).toContain("was found either: package.json is not valid JSON. Nothing was written.")
  })
})

describe("interlint init proposes the protected files", () => {
  const plugin = (artifactId: string, configuration: string) =>
    `      <plugin>\n        <artifactId>${artifactId}</artifactId>\n        <configuration>\n${configuration}        </configuration>\n      </plugin>\n`

  it("lists the @ArchTest classes and the rule files the build names, never pom.xml", async () => {
    writeFile("mvnw", "")
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    writeFile("config/checkstyle.xml", "<module/>\n")
    writeFile("config/suppressions.xml", "<suppressions/>\n")
    writeFile("pmd/ruleset.xml", "<ruleset/>\n")
    writeFile(
      "pom.xml",
      `<project>\n  <build>\n    <plugins>\n${plugin(
        "maven-checkstyle-plugin",
        "          <configLocation>config/checkstyle.xml</configLocation>\n          <suppressionsLocation>\${project.basedir}/config/suppressions.xml</suppressionsLocation>\n",
      )}${plugin(
        "maven-pmd-plugin",
        "          <rulesets>\n            <ruleset>pmd/ruleset.xml</ruleset>\n            <ruleset>/category/java/bestpractices.xml</ruleset>\n          </rulesets>\n",
      )}    </plugins>\n  </build>\n</project>\n`,
    )

    expect((await run("init")).exitCode).toBe(0)

    expect(loadConfig(projectDir).protected).toEqual([
      "src/test/java/**/ArchitectureRulesTest.java",
      "config/checkstyle.xml",
      "config/suppressions.xml",
      "pmd/ruleset.xml",
    ])
  })

  it("leaves out a rule file the project does not hold, such as one on the classpath", async () => {
    writeFile(
      "pom.xml",
      `<project>\n  <build>\n    <plugins>\n${plugin("maven-checkstyle-plugin", "          <configLocation>google_checks.xml</configLocation>\n")}    </plugins>\n  </build>\n</project>\n`,
    )

    expect((await run("init")).exitCode).toBe(0)

    expect(loadConfig(projectDir).protected).toBeUndefined()
  })

  it("lists the ESLint and dependency-cruiser configuration of an npm project in its directory, never package.json", async () => {
    writeFile(
      "web/package.json",
      JSON.stringify({ devDependencies: { eslint: "^10.0.0", "dependency-cruiser": "^17.0.0" } }),
    )
    writeFile("web/eslint.config.js", "export default []\n")
    writeFile("web/.dependency-cruiser.cjs", "module.exports = {}\n")

    expect((await run("init")).exitCode).toBe(0)

    expect(loadConfig(projectDir).protected).toEqual(["web/eslint.config.js", "web/.dependency-cruiser.cjs"])
  })

  it("lists the @ArchTest classes of each module that holds them", async () => {
    writeFile("pom.xml", "<project>\n  <modules>\n    <module>core</module>\n    <module>api</module>\n  </modules>\n</project>\n")
    writeFile("core/pom.xml", "<project/>\n")
    writeFile("api/pom.xml", "<project/>\n")
    archTest("core/src/test/java/com/acme/CoreRulesTest.java")

    expect((await run("init")).exitCode).toBe(0)

    expect(loadConfig(projectDir).protected).toEqual(["core/src/test/java/**/CoreRulesTest.java"])
  })
})
