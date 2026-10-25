#!/usr/bin/env node
// Packs Interlint as npm would publish it and runs `npx interlint init` from that package
// in a clean Maven project outside this repository. Exits non-zero if any step fails.
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const ROOT = join(import.meta.dirname, "..")
const AGENTS = {
  opencode: ".opencode/plugins/interlint/index.ts",
  "claude-code": ".claude/settings.json",
}

const scratch = mkdtempSync(join(tmpdir(), "interlint-pack-"))
try {
  const tarball = pack()
  for (const [agent, agentFile] of Object.entries(AGENTS)) {
    const projectDir = mavenProject(agent)
    run("npx", ["--yes", `--package=${tarball}`, "interlint", "init", "--agent", agent], projectDir)
    for (const file of ["interlint.yaml", agentFile]) {
      if (!existsSync(join(projectDir, file))) fail(`init --agent ${agent} did not write ${file}`)
    }
    console.log(`ok: npx interlint init --agent ${agent}`)
  }
} catch (error) {
  console.error(`pack-smoke: ${error.message}`)
  process.exitCode = 1
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

/** Runs `npm pack` (its `prepack` builds `dist/`) and returns the path of the tarball. */
function pack() {
  const output = run("npm", ["pack", "--json", "--pack-destination", scratch], ROOT)
  // `prepack` output comes before the JSON.
  const [{ filename }] = JSON.parse(output.slice(output.indexOf("[")))
  return join(scratch, filename)
}

/** A Maven project with one ArchUnit test and nothing else: no package.json, no node_modules. */
function mavenProject(name) {
  const projectDir = join(scratch, name)
  const test = join(projectDir, "src/test/java/shop/ArchitectureRulesTest.java")
  mkdirSync(dirname(test), { recursive: true })
  writeFileSync(
    test,
    [
      "package shop;",
      "",
      "import com.tngtech.archunit.junit.ArchTest;",
      "import com.tngtech.archunit.lang.ArchRule;",
      "import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;",
      "",
      "class ArchitectureRulesTest {",
      "  @ArchTest",
      '  static final ArchRule DOMAIN = noClasses().that().resideInAPackage("..domain..")',
      '      .should().dependOnClassesThat().resideInAPackage("..infra..");',
      "}",
      "",
    ].join("\n"),
  )
  return projectDir
}

function run(command, args, cwd) {
  const windows = process.platform === "win32"
  // On Windows npm and npx are .cmd scripts, which only run through a shell.
  const shellArgs = windows ? args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)) : args
  const result = spawnSync(command, shellArgs, { cwd, encoding: "utf8", shell: windows })
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} exited with ${result.status}\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout
}

function fail(message) {
  throw new Error(message)
}
