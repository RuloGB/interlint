import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { type CheckProjectDeps, checkProject, startSession } from "../../../application/checking/check-project.js"
import { protectedAmong } from "../../../application/checking/protected-files.js"
import {
  type FeedbackDeps,
  pauseSession,
  resumeSession,
  subagentCheckFiles,
  subagentStart,
  userTurn,
} from "../../../application/feedback/agent-events.js"
import type { AgentRef } from "../../../application/feedback/ports.js"
import { protectedEditQuestion } from "../../../domain/protected-files.js"
import type { AgentContext } from "../../../domain/metric.js"
import { EXIT, type Io, UsageError } from "./cli-io.js"
import { projectFiles } from "./project-paths.js"

export async function check(args: string[], io: Io, deps: CheckProjectDeps, feedback: FeedbackDeps): Promise<number> {
  const { values } = parseCheckArgs(args)
  const when = values.when ?? "task-end"
  const files = values.file ?? []
  const projectDir = resolve(io.cwd, values.cwd ?? ".")
  if (when === "session-start" || when === "pre-edit") return await forPlugin(when, values, io, projectDir, deps)
  if (when === "pause" || when === "resume" || when === "turn-start") return await pauseForPlugin(when, values, io, projectDir, feedback)
  if (when === "subagent-start") return await subagentForPlugin(values, io, projectDir, feedback)
  if (when !== "edit" && when !== "task-end") throw new UsageError(`--when must be edit or task-end (got "${when}")`)
  if (when === "edit" && files.length === 0) throw new UsageError("--when edit needs at least one --file <path>")
  if (when === "edit" && values.changed === true) throw new UsageError("--changed is only valid with --when task-end")
  const sinceStart = values["since-start"] === true
  if (when === "edit" && sinceStart) throw new UsageError("--since-start is only valid with --when task-end")
  const lines = parseLines(values.lines, files.length, when)
  const asked = values.asked === true
  const rootSession = values["root-session"]

  const agent = values["agent-context"] === true && io.stdin ? agentContextOf(await io.stdin()) : undefined
  // Files given but all outside the project hold no project, so nothing runs for them.
  let taskEndFiles = files.length > 0 ? projectFiles(io.cwd, projectDir, files) : undefined
  if (sinceStart) {
    taskEndFiles = subagentCheckFiles(projectDir, subagentOf(agent, rootSession, "--since-start"), taskEndFiles ?? [], feedback)
    // A subagent that changed nothing, by any means, has nothing to check.
    if (taskEndFiles.length === 0) return EXIT.passed
  }
  const { report, notice, passed } =
    when === "edit"
      ? await checkProject(
          projectDir,
          {
            when: "edit",
            files: projectFiles(io.cwd, projectDir, files),
            linesWritten: linesByFile(io.cwd, projectDir, files, lines),
            agent,
            asked,
            ...(rootSession === undefined ? {} : { rootSession }),
          },
          deps,
        )
      : await checkProject(
          projectDir,
          {
            when: "task-end",
            files: taskEndFiles,
            changedOnly: values.changed === true,
            agent,
            asked,
          },
          deps,
        )
  // The notice comes after the report, so output that starts with a failure still means a failure. The checks that
  // passed come last, so output that starts with a notice still means a notice.
  const output = [report, notice, passed].filter((text) => text !== "").join("\n")
  if (output !== "") io.stdout(output)
  return report === "" ? EXIT.passed : EXIT.violations
}

/**
 * The steps of the protected files that the OpenCode plugin runs, internal and left out of the usage like
 * `--agent-context`. `session-start` keeps the protected files as they are for the session in the agent's context and
 * writes nothing. `pre-edit` writes the question for the user when `--file` names protected files, so the plugin asks
 * it before its edit tool changes them, and nothing otherwise. Both exit 0.
 */
async function forPlugin(
  when: "session-start" | "pre-edit",
  values: ReturnType<typeof parseCheckArgs>["values"],
  io: Io,
  projectDir: string,
  deps: CheckProjectDeps,
): Promise<number> {
  if (when === "session-start") {
    const agent = values["agent-context"] === true && io.stdin ? agentContextOf(await io.stdin()) : undefined
    startSession(projectDir, agent, deps)
    return EXIT.passed
  }
  const files = projectFiles(io.cwd, projectDir, values.file ?? [])
  if (deps.protection === undefined || files.length === 0) return EXIT.passed
  const guarded = protectedAmong(deps.loadConfig(projectDir), files)
  if (guarded.length > 0) io.stdout(`${protectedEditQuestion(guarded)}\n`)
  return EXIT.passed
}

/**
 * The pause and resume of a main session that the OpenCode plugin runs (F26), internal and left out of the usage like
 * `--agent-context`, which gives the session. The plugin reads the marks in the user's prompt and decides; the CLI
 * keeps the pause, restarts the session's state on resume and keeps the metrics. `turn-start`, for a prompt without a
 * mark in an active session, takes what changed since the agent's last turn ended as the user's. Writes nothing and
 * exits 0.
 */
async function pauseForPlugin(
  when: "pause" | "resume" | "turn-start",
  values: ReturnType<typeof parseCheckArgs>["values"],
  io: Io,
  projectDir: string,
  deps: FeedbackDeps,
): Promise<number> {
  const agent = values["agent-context"] === true && io.stdin ? agentContextOf(await io.stdin()) : undefined
  const session = agent?.session
  if (session === undefined) throw new UsageError(`--when ${when} needs the session in --agent-context`)
  if (when === "pause") await pauseSession(projectDir, session, deps, agent)
  else if (when === "resume") await resumeSession(projectDir, session, deps, agent)
  else await userTurn(projectDir, session, deps)
  return EXIT.passed
}

/**
 * The start of a subagent that the OpenCode plugin runs before each prompt the subagent gets, internal and left out of
 * the usage like `--agent-context`, which gives the subagent's session; `--root-session` gives its main session. The
 * CLI keeps each project's fingerprint, so `--when task-end --since-start` also checks the projects the subagent
 * changed through a shell. Writes nothing and exits 0.
 */
async function subagentForPlugin(
  values: ReturnType<typeof parseCheckArgs>["values"],
  io: Io,
  projectDir: string,
  deps: FeedbackDeps,
): Promise<number> {
  for (const option of ["file", "lines", "changed", "since-start", "asked"] as const) {
    if (values[option] !== undefined) throw new UsageError(`--when subagent-start does not take --${option}`)
  }
  const agent = values["agent-context"] === true && io.stdin ? agentContextOf(await io.stdin()) : undefined
  subagentStart(projectDir, subagentOf(agent, values["root-session"], "--when subagent-start"), deps)
  return EXIT.passed
}

/** The subagent of the agent's context: its own session, under its main session `rootSession` when given. */
function subagentOf(agent: AgentContext | undefined, rootSession: string | undefined, option: string): AgentRef {
  const session = agent?.session
  if (session === undefined) throw new UsageError(`${option} needs the session in --agent-context`)
  return { sessionId: rootSession ?? session, agentId: session }
}

/**
 * The `--lines` values, one for each `--file` in the same place: the lines the edit wrote in that file. None given,
 * the files wrote no lines.
 */
function parseLines(values: string[] | undefined, files: number, when: string): number[] {
  if (values === undefined) return []
  if (when !== "edit") throw new UsageError("--lines is only valid with --when edit")
  if (values.length !== files) {
    throw new UsageError(`--lines needs one value for each --file (got ${values.length} --lines for ${files} --file)`)
  }
  return values.map((value) => {
    if (!/^\d+$/.test(value)) throw new UsageError(`--lines must be a whole number of 0 or more (got "${value}")`)
    return Number(value)
  })
}

/** The lines written in each file, by its path relative to the project. Files outside it are left out. */
function linesByFile(cwd: string, projectDir: string, files: string[], lines: number[]): Map<string, number> {
  const written = new Map<string, number>()
  files.forEach((file, index) => {
    const [path] = projectFiles(cwd, projectDir, [file])
    if (path !== undefined) written.set(path, (written.get(path) ?? 0) + (lines[index] ?? 0))
  })
  return written
}

const CONTEXT_FIELDS = ["agent", "session", "agentType", "model", "provider"] as const

/**
 * The agent's context, as the OpenCode plugin writes it on stdin with `--agent-context`, for the metrics only
 * (decision 34). The option is internal and left out of the usage. What is not a field it expects is left out, and a
 * context it cannot read is none: the checks run the same either way.
 */
function agentContextOf(text: string): AgentContext | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null) return undefined
  const fields = value as Record<string, unknown>
  const context: AgentContext = {}
  for (const field of CONTEXT_FIELDS) {
    const given = fields[field]
    if (typeof given === "string" && given !== "") context[field] = given
  }
  if (fields.subagent === true) context.subagent = true
  return context
}

function parseCheckArgs(args: string[]) {
  try {
    return parseArgs({
      args,
      options: {
        when: { type: "string" },
        cwd: { type: "string" },
        file: { type: "string", multiple: true },
        lines: { type: "string", multiple: true },
        changed: { type: "boolean" },
        "agent-context": { type: "boolean" },
        asked: { type: "boolean" },
        "root-session": { type: "string" },
        "since-start": { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    })
  } catch (error) {
    throw new UsageError((error as Error).message)
  }
}
