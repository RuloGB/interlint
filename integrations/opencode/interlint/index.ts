/**
 * Interlint adapter for OpenCode V2.
 *
 * After a tool changes files (`edit`, `write`, `patch`), it runs `interlint check --when edit` for them
 * and appends any failures to that tool's result, so the agent sees them before it repeats the mistake.
 *
 * The task-end failures go to the agent that wrote the code, and to the agent that delegated it only when that one
 * cannot fix them:
 *
 * - When the main agent's turn ends (`session.execution.succeeded`), it runs `interlint check --when task-end --changed`,
 *   which runs the checks of the projects that changed since their checks last passed. If a check fails, it resumes
 *   the session with the formatted failures so the agent fixes them, up to MAX_CONSECUTIVE_BLOCKS times in a row.
 *   While one of its subagents has changes whose checks have not passed yet, it waits for that subagent first.
 *   OpenCode shows the turn as ended meanwhile, so checks that run longer than DEFAULT_RUNNING_NOTICE_MS tell the
 *   user in a message that they are running.
 * - When a subagent's turn ends, it runs the task-end checks of the projects holding the files that subagent changed
 *   with an edit tool, and resumes the subagent with the failures, up to MAX_CONSECUTIVE_BLOCKS times. A subagent
 *   that changed no file, such as a read-only reviewer, runs nothing. The user sees in the subagent's session that
 *   the checks are running and how they ended, as in the main agent's.
 * - OpenCode has no hook that keeps a session from ending, and the `subagent` tool returns the subagent's first answer.
 *   So the plugin holds that answer in the tool's `execute.after` hook until the subagent's checks pass, and adds
 *   what happened. If the subagent cannot fix them, the answer carries the failures to the agent that delegated
 *   the work, which answers for those files from then on. For a subagent in the background, a message does that.
 *
 * The user pauses Interlint in a main session by writing `interlint: pause` in a prompt, and resumes it with
 * `interlint: resume` (F26). The session's `prompt` hook reads the marks, only in main sessions: the prompt of a
 * subagent's session is written by the agent. While paused, nothing runs in that session or its subagents, and each
 * turn end of the main agent reminds the user. The pause lives in this plugin's memory; the CLI keeps it too, restarts
 * the session's state on resume and keeps the metrics.
 *
 * `session.idle` is not used: in OpenCode 2.1.4 it never reaches a plugin's event subscription.
 *
 * One OpenCode server runs the sessions of every open project, and its plugins get the events and tool calls of all
 * of them. The plugin acts only on the sessions that run in its own directory or inside it.
 *
 * Install: `interlint init --agent opencode`, which copies this directory to `.opencode/plugins/interlint/`.
 * The file has no runtime imports besides Node built-ins: `Plugin.define` from `@opencode/plugin`
 * is the identity function, so the plain definition below is equivalent.
 */
import { spawn } from "node:child_process"
import { realpathSync } from "node:fs"
import { resolve as resolvePath, sep } from "node:path"

export const MAX_CONSECUTIVE_BLOCKS = 3
/** Keeps the text injected into the session bounded, like the CLI does with build output. */
export const MAX_OUTPUT_CHARS = 64 * 1024
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
/** The agent waits for an edit check before it gets the tool result, so a stuck one gives up sooner. */
export const DEFAULT_EDIT_TIMEOUT_MS = 2 * 60 * 1000
/**
 * How long Interlint waits for a subagent: for the turn it resumed to end, and before the main agent's checks run
 * while that subagent has unchecked changes. Past it, the subagent's failures are the main agent's.
 */
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 30 * 60 * 1000
/**
 * How long the main agent's task-end checks run before the plugin tells the user they are running. OpenCode shows the
 * turn as ended while they run; a run that ends sooner, such as one with no changed project, adds no message.
 */
export const DEFAULT_RUNNING_NOTICE_MS = 2 * 1000
/** How long the result of the checks waits for the running notice to be sent, so a stuck notice cannot hold it. */
export const RUNNING_NOTICE_WAIT_MS = 5 * 1000

const TURN_START = "session.execution.started"
type TurnEnd = "succeeded" | "failed" | "interrupted"
const TURN_ENDS = new Map<string, TurnEnd>([
  ["session.execution.succeeded", "succeeded"],
  ["session.execution.failed", "failed"],
  ["session.execution.interrupted", "interrupted"],
])
/** The built-in tool that runs a subagent. Its result says whether the subagent finished or runs in the background. */
const SUBAGENT_TOOL = "subagent"
const SESSION_DELETED = "session.deleted"
/** Every report the Interlint CLI prints starts with this mark. */
const REPORT_MARK = "✗ "
/** How the CLI starts a notice for the user, such as a FreezingArchRule store to refreeze, when no check failed. */
const NOTICE_MARK = "ℹ Interlint · for the user:"
/** How the CLI starts the line that names the checks that ran, when they all passed. */
const PASSED_MARK = "✓ Interlint · "
/** The message that tells the user the task-end checks are still running after the agent's turn ended. */
const RUNNING_MESSAGE = "Interlint: running checks"
/** Closes the running notice when the checks end with nothing else to say, such as when no project changed. */
const FINISHED_MESSAGE = "Interlint: checks finished"
/** The name the CLI gives the failure of the protected files in its report. */
const PROTECTED_CHECK = "protected files"
/** What the main agent is told before its task-end failures. */
const MAIN_BLOCK_NOTE =
  "Fix these failures before you answer: they are in the projects this task changed, so fixing them is part of the task, even if you were asked to change nothing else. Asking the user whether to fix them does not end the task."
/** What the note adds when the protected files failed too: their message may tell the agent to ask the user. */
const PROTECTED_APART_NOTE = " The protected files are a separate case: follow the instructions in their own message."
/** Only the projects that changed since their checks last passed: a workspace may hold many. */
const TASK_END_ARGS = ["check", "--when", "task-end", "--changed"]
/** Tells the CLI the user paused or resumed Interlint in the main session of `--agent-context` (F26). */
const PAUSE_ARGS = ["check", "--when", "pause"]
const RESUME_ARGS = ["check", "--when", "resume"]
/** Takes what changed since the agent's last turn ended, such as a `git pull`, as the user's. */
const TURN_START_ARGS = ["check", "--when", "turn-start"]
/** The marks as the user writes them, in any case, anywhere in the prompt. The same as the CLI's. */
const PAUSE_MARK = /interlint:[ \t]*(pause|resume)(?![\p{L}\p{N}_-])/giu
/** The same words as the CLI's. */
const PAUSED_MESSAGE = "Interlint is paused in this session."
/** The same words as the CLI's. */
const RESUMED_MESSAGE = "Interlint is active again in this session."
/** The same words as the CLI's. */
const NOT_PAUSED_MESSAGE = "Interlint is not paused in this session."
/** The same words as the CLI's. */
const PAUSED_REMINDER = "ℹ Interlint · paused in this session."
/** The same words as the CLI's. */
const PAUSE_ADVICE = 'Write "interlint: pause" to pause Interlint in this session, and "interlint: resume" to turn it back on.'

/** Keeps the protected files of the session in the agent's context as they are. */
const SESSION_START_ARGS = ["check", "--when", "session-start"]
/** The permission OpenCode evaluates before the `edit`, `write` and `patch` tools change files. */
const EDIT_PERMISSION = "edit"
/** The built-in tools that change files. */
const FILE_TOOLS = new Set(["edit", "write", "patch"])
const PATCH_FILE_HEADER = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm
/**
 * File paths go to the shell inside double quotes. A path with a character that sh or cmd.exe
 * could expand there (`$`, a backquote, `"`, `%`, `!`, `^`) is not passed at all.
 */
const SHELL_SAFE_PATH = /^[\p{L}\p{N} _\-./\\:@+,()[\]~#]+$/u

export interface CheckRun {
  exitCode: number
  output: string
}

export type Decision = { action: "none" } | { action: "continue"; text: string } | { action: "report"; text: string }

/**
 * The line that names the checks that passed, so the user sees Interlint ran. Undefined when none ran, or when an
 * Interlint older than this plugin printed nothing.
 */
/**
 * The `description` of a message the plugin sends: its first line. OpenCode Desktop shows a synthetic message in the
 * chat by its description alone, so it must say what happened.
 */
function label(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim() !== "")?.trim() ?? "Interlint"
}

function passedLine(run: CheckRun): string | undefined {
  if (run.exitCode !== 0) return undefined
  return run.output.split(/\r?\n/).find((line) => line.startsWith(PASSED_MARK))
}

/**
 * The line that names the checks that failed after an edit, each once, for the user: the agent gets the failures in
 * the tool result. Undefined when the checks passed or could not run.
 */
function failedLine(run: CheckRun): string | undefined {
  if (!isReport(run)) return undefined
  return `${REPORT_MARK}Interlint · checks failed after this edit: ${failedNames(run.output).join(", ")}`
}

/** The names of the checks that failed in a report of the CLI, each once. */
function failedNames(output: string): string[] {
  const names = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith(REPORT_MARK) && line.includes(" · "))
    .map((line) => line.slice(REPORT_MARK.length, line.indexOf(" · ")))
  return [...new Set(names)]
}

/** Whether the CLI ran and found failures. cmd.exe also exits with 1 when it cannot find the CLI, so exit 1 alone does not mean violations. */
function isReport(run: CheckRun): boolean {
  return run.exitCode === 1 && run.output.startsWith(REPORT_MARK)
}

/** The message that resumes an agent whose task-end checks failed. */
function blockText(attempt: number, output: string): string {
  return `Interlint: the task cannot end yet (attempt ${attempt} of ${MAX_CONSECUTIVE_BLOCKS}).\n\n${output}`
}

/**
 * The message that resumes the main agent whose task-end checks failed. One told to change nothing else answers with
 * a question instead of a fix, and each question only spends an attempt. The protected files' failure says what to
 * do itself, which may be to ask the user: alone it gets no note, and next to a failed check the note leaves it apart.
 */
function mainBlockText(attempt: number, output: string): string {
  const failed = failedNames(output)
  if (!failed.some((name) => name !== PROTECTED_CHECK)) return blockText(attempt, output)
  const apart = failed.includes(PROTECTED_CHECK) ? PROTECTED_APART_NOTE : ""
  return blockText(attempt, `${MAIN_BLOCK_NOTE}${apart}\n\n${output}`)
}

/**
 * The message that resumes a subagent whose task-end checks failed. A subagent that answers with a question instead
 * of a fix only spends an attempt: nobody answers it, and its parent waits.
 */
function subagentBlockText(attempt: number, output: string): string {
  return blockText(
    attempt,
    `Fix these failures yourself before you answer: asking how to proceed does not end the task. After ${MAX_CONSECUTIVE_BLOCKS} attempts they go to the agent that delegated this work.\n\n${output}`,
  )
}

/**
 * What the user reads in a subagent's session when its task-end checks pass: the line that names them, a notice for
 * the user, or the line that closes the running notice. Nothing when there is nothing to say.
 */
function subagentResultLine(run: CheckRun, noticed: boolean): string | undefined {
  if (run.output.startsWith(NOTICE_MARK)) return run.output
  return passedLine(run) ?? (noticed ? FINISHED_MESSAGE : undefined)
}

/** What the user reads in a subagent's session when its checks still fail after its last attempt. */
function subagentGaveUpLine(run: CheckRun): string {
  return `${REPORT_MARK}Interlint · checks still fail after ${MAX_CONSECUTIVE_BLOCKS} attempts: ${failedNames(run.output).join(", ")}. They go to the agent that delegated this work.`
}

/** The mark in a user's prompt: the last one when it holds both. None without a mark. The same as the CLI's. */
export function pauseMark(text: unknown): "pause" | "resume" | undefined {
  if (typeof text !== "string") return undefined
  let mark: "pause" | "resume" | undefined
  for (const match of text.matchAll(PAUSE_MARK)) mark = match[1]!.toLowerCase() as "pause" | "resume"
  return mark
}

/** Decides what to do with a task-end check result. Keeps one block counter per session. */
export class TaskEndGate {
  private readonly blocks = new Map<string, number>()

  decide(sessionID: string, run: CheckRun): Decision {
    if (run.exitCode === 0) {
      this.blocks.delete(sessionID)
      // A notice is for the user, and so are the checks that passed: reported in the session without resuming the agent.
      if (run.output.startsWith(NOTICE_MARK)) return { action: "report", text: run.output }
      const passed = passedLine(run)
      return passed === undefined ? { action: "none" } : { action: "report", text: passed }
    }
    if (!isReport(run)) {
      this.blocks.delete(sessionID)
      return { action: "report", text: `Interlint could not run the checks (exit code ${run.exitCode}).\n\n${run.output}` }
    }

    const attempt = (this.blocks.get(sessionID) ?? 0) + 1
    if (attempt > MAX_CONSECUTIVE_BLOCKS) {
      this.blocks.delete(sessionID)
      return {
        action: "report",
        // Only the user reads it before the next prompt: the advice to pause goes nowhere the agent acts on (F26).
        text: `Interlint: the checks still fail after ${MAX_CONSECUTIVE_BLOCKS} attempts, so the task may end.\n\n${run.output.trimEnd()}\n\n${PAUSE_ADVICE}\n`,
      }
    }
    this.blocks.set(sessionID, attempt)
    return { action: "continue", text: mainBlockText(attempt, run.output) }
  }

  /** Forgets the session's blocks, as when the user resumes Interlint in it. */
  reset(sessionID: string): void {
    this.blocks.delete(sessionID)
  }
}

/** How the task-end checks of a subagent's changes ended. */
export type Settled =
  /** They passed at once, or it had nothing left to check. */
  | { kind: "clean" }
  /** They failed, and the subagent fixed them. */
  | { kind: "fixed" }
  /** They still failed after MAX_CONSECUTIVE_BLOCKS attempts. */
  | { kind: "failing"; output: string }
  /** The subagent's turn failed or was interrupted before they passed. */
  | { kind: "stopped"; output: string }
  /** They could not run. */
  | { kind: "error"; run: CheckRun }

/** What the plugin adds to the answer of a foreground subagent, for the agent that delegated the work. */
export function answerNote(settled: Settled): string | undefined {
  switch (settled.kind) {
    case "clean":
      return undefined
    case "fixed":
      return "Interlint: the checks failed after this answer, so the subagent went on to fix them. They pass now."
    case "failing":
      return `Interlint: the subagent could not make the checks pass after ${MAX_CONSECUTIVE_BLOCKS} attempts, so they are yours to fix.\n\n${settled.output}`
    case "stopped":
      return `Interlint: the subagent stopped before the checks passed, so they are yours to fix.\n\n${settled.output}`
    case "error":
      return `Interlint could not run the checks of the subagent's changes (exit code ${settled.run.exitCode}).\n\n${settled.run.output}`
  }
}

/** What the plugin sends to the parent of a background subagent, or nothing when there is nothing to tell. */
export function parentNote(sessionID: string, settled: Settled): { text: string; resume: boolean } | undefined {
  switch (settled.kind) {
    case "clean":
    case "fixed":
      return undefined
    case "failing":
      return {
        text: `Interlint: subagent session ${sessionID} could not make the checks pass after ${MAX_CONSECUTIVE_BLOCKS} attempts, so they are yours to fix.\n\n${settled.output}`,
        resume: true,
      }
    case "stopped":
      return {
        text: `Interlint: subagent session ${sessionID} stopped before the checks passed, so they are yours to fix.\n\n${settled.output}`,
        resume: true,
      }
    case "error":
      // Not the subagent's mistake, nor its parent's: the parent's own task end reports it too.
      return {
        text: `Interlint could not run the checks of subagent session ${sessionID} (exit code ${settled.run.exitCode}).\n\n${settled.run.output}`,
        resume: false,
      }
  }
}

/** The files a tool call changed, as the tool received them. Empty for tools that change no file. */
export function changedFiles(tool: string, input: unknown): string[] {
  if (!FILE_TOOLS.has(tool) || typeof input !== "object" || input === null) return []
  const { path, patchText } = input as { path?: unknown; patchText?: unknown }
  if (tool === "patch") {
    return typeof patchText === "string" ? [...patchText.matchAll(PATCH_FILE_HEADER)].map((match) => match[1]!.trim()) : []
  }
  return typeof path === "string" ? [path] : []
}

/**
 * The lines a tool call wrote in each file it changed: those an edit adds or changes, every line of a write, and the
 * added lines of each file of a patch. A file it wrote no line in, such as one a patch deletes, is left out.
 */
export function linesWritten(tool: string, input: unknown): Map<string, number> {
  const written = new Map<string, number>()
  if (!FILE_TOOLS.has(tool) || typeof input !== "object" || input === null) return written
  const { path, oldString, newString, content, patchText } = input as Record<string, unknown>
  if (tool === "patch") {
    if (typeof patchText !== "string") return written
    let file: string | undefined
    for (const line of patchText.split(/\r?\n/)) {
      const header = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/.exec(line)
      // Lines after `Move to` still belong to the file the patch updates.
      if (header) file = header[1] === "Move to" ? file : header[2]!.trim()
      else if (file !== undefined && line.startsWith("+")) written.set(file, (written.get(file) ?? 0) + 1)
    }
    return written
  }
  if (typeof path !== "string") return written
  if (typeof newString === "string") written.set(path, countWritten(typeof oldString === "string" ? oldString : "", newString))
  else if (typeof content === "string") written.set(path, countWritten("", content))
  return written
}

/**
 * How many lines of `after` are not matched by a line of `before`, each line of `before` matching once: the lines an
 * edit adds or changes, not the ones it keeps around them. The same count as Interlint's own, for the Claude Code hook.
 */
function countWritten(before: string, after: string): number {
  const lines = (text: string) => (text === "" ? [] : text.replace(/\r?\n$/, "").split(/\r?\n/))
  const kept = new Map<string, number>()
  for (const line of lines(before)) kept.set(line, (kept.get(line) ?? 0) + 1)
  let written = 0
  for (const line of lines(after)) {
    const left = kept.get(line) ?? 0
    if (left > 0) kept.set(line, left - 1)
    else written++
  }
  return written
}

/** The note added to a tool result after an edit, or nothing when the checks pass or could not run. */
export function editNote(run: CheckRun): string | undefined {
  // A run that could not happen is not the agent's mistake: the task-end check reports it.
  if (!isReport(run)) return undefined
  return `Interlint: the checks fail after this edit.\n\n${run.output}`
}

type ToolContent = string | readonly { type: string; text?: string }[]
type ToolResult = { content?: ToolContent; metadata?: { sessionID?: unknown; status?: unknown } }

/** What OpenCode passes to an `execute.after` hook. Replacing `result` changes what the agent sees. */
interface ToolExecuted {
  readonly tool: string
  /** The session of the agent that called the tool. */
  readonly sessionID: string
  readonly input: unknown
  readonly status: "completed" | "error"
  result?: ToolResult
}

function withNote(result: ToolResult | undefined, text: string): ToolResult {
  const content = result?.content
  return {
    ...result,
    content: typeof content === "string" ? `${content}\n\n${text}` : [...(content ?? []), { type: "text", text }],
  }
}

/** What OpenCode gives a `model.request` session hook: the session, why it asks, and the model it asks. */
interface ModelRequest {
  readonly sessionID: string
  /** `primary` for the agent's own turns; others, such as `title`, ask another model for OpenCode itself. */
  readonly kind?: string
  readonly model?: { id?: unknown; providerID?: unknown }
}

/**
 * Who runs the checks, for Interlint's metrics: written as JSON on the stdin of `interlint check --agent-context`
 * (decision 34). A field OpenCode does not give is left out.
 */
export interface AgentContext {
  agent: "opencode"
  session: string
  subagent?: true
  agentType?: string
  model?: string
  provider?: string
}

/** The part of the OpenCode V2 plugin context this adapter uses. */
interface PluginContext {
  location: { directory: string }
  options?: {
    command?: unknown
    timeoutMs?: unknown
    editTimeoutMs?: unknown
    subagentTimeoutMs?: unknown
    runningNoticeMs?: unknown
  }
  session: {
    /**
     * A forked session has no `parentID`: only the sessions a subagent runs in have one. `location` is where the
     * session runs, which may be another project open in the same OpenCode.
     */
    get(input: { sessionID: string }): Promise<{
      parentID?: string
      location?: { directory?: unknown }
      /** The kind of agent, such as `explore` in a subagent. */
      agent?: unknown
      model?: { id?: unknown; providerID?: unknown }
    }>
    /** Absent on an OpenCode without session hooks: the metrics then ask `get` for the model. */
    hook?(name: "model.request", callback: (event: ModelRequest) => void): Promise<{ dispose(): Promise<void> }>
    /** Fires for every prompt into a session, a subagent's included, before it is sent. */
    hook?(name: "prompt", callback: (event: PromptEvent) => Promise<void> | void): Promise<{ dispose(): Promise<void> }>
    synthetic(input: { sessionID: string; text: string; description?: string; resume?: boolean }): Promise<unknown>
  }
  event: {
    subscribe(input: { signal: AbortSignal }): AsyncIterable<{ type: string; data?: { sessionID?: string } }>
  }
  tool: {
    hook(
      name: "execute.after",
      callback: (event: ToolExecuted) => Promise<void> | void,
    ): Promise<{ dispose(): Promise<void> }>
  }
  /** Absent on an OpenCode without permission hooks: the user is then not asked before a protected file changes. */
  permission?: {
    hook?(
      name: "evaluate",
      callback: (event: PermissionEvaluation) => Promise<void> | void,
    ): Promise<{ dispose(): Promise<void> }>
  }
}

/** A prompt about to go into a session. Only `text` is read. */
export interface PromptEvent {
  readonly sessionID: string
  readonly prompt?: { text?: unknown }
}

/** A permission OpenCode is about to grant or ask for. Setting `effect` to `ask` makes it ask the user, with `message`. */
export interface PermissionEvaluation {
  readonly sessionID: string
  readonly action: string
  /** For `edit`, the paths the `edit`, `write` or `patch` tool is about to change. */
  readonly resources: readonly string[]
  effect: "allow" | "ask" | "deny"
  message?: string
}

export type RunChecks = (
  directory: string,
  command: string,
  timeoutMs: number,
  args?: string[],
  context?: AgentContext,
) => Promise<CheckRun>

/** The fix loop of a subagent. `awaited` is set when the parent's `subagent` tool waits for it to tell what happened. */
interface Settling {
  awaited: boolean
  done: Promise<Settled>
}

export function createInterlintPlugin(runChecks: RunChecks = runInterlint) {
  return {
    id: "interlint",
    async setup(ctx: PluginContext) {
      const command = typeof ctx.options?.command === "string" ? ctx.options.command : "interlint"
      const timeoutMs = typeof ctx.options?.timeoutMs === "number" ? ctx.options.timeoutMs : DEFAULT_TIMEOUT_MS
      const editTimeoutMs =
        typeof ctx.options?.editTimeoutMs === "number" ? ctx.options.editTimeoutMs : DEFAULT_EDIT_TIMEOUT_MS
      const subagentTimeoutMs =
        typeof ctx.options?.subagentTimeoutMs === "number" ? ctx.options.subagentTimeoutMs : DEFAULT_SUBAGENT_TIMEOUT_MS
      const noticeOption = ctx.options?.runningNoticeMs
      const runningNoticeMs =
        typeof noticeOption === "number" && Number.isFinite(noticeOption) && noticeOption >= 0
          ? noticeOption
          : DEFAULT_RUNNING_NOTICE_MS
      const directory = ctx.location.directory
      const gate = new TaskEndGate()
      const running = new Set<string>()
      const controller = new AbortController()
      /** The files each session changed with an edit tool since its own task-end checks last passed. */
      const written = new Map<string, Set<string>>()
      /** What each session is to this plugin: its parent, whether it runs in this plugin's project, and its agent. */
      const lookups = new Map<string, { parent: string | undefined; ours: boolean; agent?: string }>()
      /** The model of each session's last own request, for the metrics. */
      const models = new Map<string, { model?: string; provider?: string }>()
      const settling = new Map<string, Settling>()
      /** The sessions Interlint resumed, waiting for the end of the turn that resume started. */
      const resumed = new Map<string, { started: boolean; resolve: (end: TurnEnd) => void }>()
      /** Main sessions whose turn end waited for a subagent with unchecked changes. */
      const deferred = new Set<string>()
      /** Ends the wait of a deferred main session after subagentTimeoutMs, per main session. */
      const deferTimers = new Map<string, ReturnType<typeof setTimeout>>()
      /** The sessions whose protected files Interlint keeps since their first turn, each until the CLI did it. */
      const started = new Map<string, Promise<void>>()
      /** The main sessions the user paused Interlint in (F26). */
      const paused = new Set<string>()

      const lookup = async (sessionID: string) => {
        const known = lookups.get(sessionID)
        if (known) return known
        try {
          const { parentID, location, agent } = await ctx.session.get({ sessionID })
          const parent = typeof parentID === "string" ? parentID : undefined
          // OpenCode runs the sessions of every open project in one server, and gives each plugin all their events.
          const where = location?.directory
          const ours = typeof where !== "string" || isWithin(where, directory)
          const session = { parent, ours, ...(typeof agent === "string" && agent !== "" ? { agent } : {}) }
          lookups.set(sessionID, session)
          return session
        } catch (error) {
          // Treated as this project's main agent: running its checks is better than not running them at all.
          console.error("[interlint] could not read session", sessionID, error)
          return { parent: undefined, ours: true }
        }
      }

      const parentOf = async (sessionID: string) => (await lookup(sessionID)).parent

      /**
       * Who runs the checks of a session, for the metrics. The model is the one of the session's last own request,
       * or, before any, the one the session gives now: a model switched later is not cached here. A session whose
       * lookup failed is not looked up again for this: it gets the session alone.
       */
      const contextOf = async (sessionID: string): Promise<AgentContext> => {
        const known = lookups.get(sessionID)
        if (known === undefined) return { agent: "opencode", session: sessionID }
        const { parent, agent } = known
        let model = models.get(sessionID)
        if (model === undefined) {
          try {
            model = modelOf((await ctx.session.get({ sessionID })).model)
          } catch {
            model = {}
          }
        }
        return {
          agent: "opencode",
          session: sessionID,
          ...(parent === undefined ? {} : { subagent: true as const, ...(agent === undefined ? {} : { agentType: agent }) }),
          ...model,
        }
      }

      // Only the agent's own requests: OpenCode also asks other models, such as one that writes the session's title.
      // A hook that fails, at once or later, only leaves the metrics to ask the session: the checks still run.
      let modelHook: { dispose(): Promise<void> } | undefined
      try {
        modelHook = await ctx.session.hook?.("model.request", (event) => {
          if (event.kind === "primary") models.set(event.sessionID, modelOf(event.model))
        })
      } catch (error) {
        console.error("[interlint] could not follow the session's model", error)
      }
      /** Whether the session runs in this plugin's project, so its changes are this project's to check. */
      const isOurs = async (sessionID: string) => (await lookup(sessionID)).ours

      const rootOf = async (sessionID: string) => {
        let session = sessionID
        for (let parent = await parentOf(session); parent !== undefined; parent = await parentOf(session)) session = parent
        return session
      }

      /** Whether the user paused Interlint in the session's main session. */
      const isPaused = async (sessionID: string) => paused.size > 0 && paused.has(await rootOf(sessionID))

      /**
       * The main session of a session, as far as the lookups made so far tell: no new lookup, which may wait. A parent
       * not looked up yet is taken as the main session, as a subagent's parent usually is.
       */
      const knownRootOf = (sessionID: string) => {
        let session = sessionID
        for (let parent = lookups.get(session)?.parent; parent !== undefined; parent = lookups.get(session)?.parent) {
          session = parent
        }
        return session
      }

      const record = (sessionID: string, files: Iterable<string>) => {
        const own = written.get(sessionID) ?? new Set<string>()
        for (const file of files) own.add(file)
        written.set(sessionID, own)
      }

      /** Gives a subagent's unchecked changes to its parent, which answers for them from now on. */
      const handOver = async (sessionID: string) => {
        const files = written.get(sessionID)
        written.delete(sessionID)
        const parent = await parentOf(sessionID)
        if (files && parent !== undefined) record(parent, files)
      }

      /** Whether a subagent under the main session `root` still has changes whose checks have not passed. */
      const hasUncheckedSubagent = async (root: string) => {
        for (const sessionID of new Set([...written.keys(), ...settling.keys()])) {
          if (sessionID === root || (!settling.has(sessionID) && !written.get(sessionID)?.size)) continue
          if ((await rootOf(sessionID)) === root) return true
        }
        return false
      }

      /** Ends the wait of a main session, with its timer, so a later wait gets the whole time limit. */
      const undefer = (root: string) => {
        clearTimeout(deferTimers.get(root))
        deferTimers.delete(root)
        return deferred.delete(root)
      }

      const flushDeferred = async () => {
        for (const root of [...deferred]) {
          if (await hasUncheckedSubagent(root)) continue
          // The main session's own turn end may have taken it meanwhile, and runs the checks itself.
          if (!undefer(root)) continue
          onTurnEnd(root).catch((error) => console.error("[interlint]", error))
        }
      }

      /**
       * Bounds how long a main session waits for its subagents. A subagent that edited files and then never ended
       * its turn would otherwise keep the main agent's checks from running at all: its changes become the main
       * agent's. A subagent still in its fix loop is left alone, since that loop has its own limit.
       */
      const armDeferTimer = (root: string) => {
        if (deferTimers.has(root)) return
        const timer = setTimeout(() => {
          deferTimers.delete(root)
          void (async () => {
            if (!deferred.has(root)) return
            for (const sessionID of [...written.keys()]) {
              if (sessionID !== root && !settling.has(sessionID) && (await rootOf(sessionID)) === root) {
                written.delete(sessionID)
              }
            }
            await flushDeferred()
          })().catch((error) => console.error("[interlint]", error))
        }, subagentTimeoutMs)
        timer.unref?.()
        deferTimers.set(root, timer)
      }

      /** The end of the turn Interlint resumed, or "interrupted" when it does not come within subagentTimeoutMs. */
      const resumedTurnEnd = (sessionID: string, turnEnd: Promise<TurnEnd>) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<TurnEnd>((resolve) => {
          timer = setTimeout(() => {
            resumed.delete(sessionID)
            console.error("[interlint] subagent session", sessionID, "did not end its turn in time")
            resolve("interrupted")
          }, subagentTimeoutMs)
          timer.unref?.()
        })
        return Promise.race([turnEnd, timeout]).finally(() => clearTimeout(timer))
      }

      /** Runs the checks of a subagent's changes and resumes it with the failures until they pass. */
      const fixLoop = async (sessionID: string): Promise<Settled> => {
        for (let attempt = 1; ; attempt++) {
          const files = [...(written.get(sessionID) ?? [])]
          if (files.length === 0) return { kind: "clean" }
          const args = [...TASK_END_ARGS, ...files.flatMap((file) => ["--file", file])]
          const context = await contextOf(sessionID)
          const { run, noticed } = await withRunningNotice(sessionID, () =>
            runChecks(directory, command, timeoutMs, args, context),
          )
          if (run.exitCode === 0) {
            written.delete(sessionID)
            // Awaited, so the user reads it in the subagent's session before its answer reaches the parent.
            await tellUser(sessionID, subagentResultLine(run, noticed))
            return attempt === 1 ? { kind: "clean" } : { kind: "fixed" }
          }
          if (!isReport(run)) {
            await tellUser(sessionID, `Interlint could not run the checks (exit code ${run.exitCode}).`)
            return { kind: "error", run }
          }
          if (attempt > MAX_CONSECUTIVE_BLOCKS) {
            await tellUser(sessionID, subagentGaveUpLine(run))
            return { kind: "failing", output: run.output }
          }
          // Registered before the resume, so the turn it starts cannot end unseen.
          const turnEnd = new Promise<TurnEnd>((resolve) => resumed.set(sessionID, { started: false, resolve }))
          try {
            await ctx.session.synthetic({
              sessionID,
              text: subagentBlockText(attempt, run.output),
              description: label(subagentBlockText(attempt, run.output)),
              resume: true,
            })
          } catch (error) {
            resumed.delete(sessionID)
            throw error
          }
          if ((await resumedTurnEnd(sessionID, turnEnd)) !== "succeeded") return { kind: "stopped", output: run.output }
        }
      }

      /** Shows the user a line in the session without resuming its agent. A line that cannot be sent is only logged. */
      const tellUser = async (sessionID: string, text: string | undefined) => {
        if (text === undefined) return
        await ctx.session
          .synthetic({ sessionID, text, description: label(text), resume: false })
          .catch((error) => console.error("[interlint]", error))
      }

      const tellParent = async (sessionID: string, settled: Settled) => {
        const note = parentNote(sessionID, settled)
        const parent = await parentOf(sessionID)
        if (!note || parent === undefined) return
        await ctx.session.synthetic({ sessionID: parent, text: note.text, description: label(note.text), resume: note.resume })
        // The parent resumes, and its own turn end runs its checks. If the message failed, the flush runs them.
        if (note.resume) undefer(parent)
      }

      /** Starts the fix loop of a subagent, or returns the one already running. */
      const settle = (sessionID: string): Settling => {
        const current = settling.get(sessionID)
        if (current) return current
        const entry: Settling = { awaited: false, done: Promise.resolve<Settled>({ kind: "clean" }) }
        entry.done = fixLoop(sessionID)
          .catch((error): Settled => ({ kind: "error", run: { exitCode: 2, output: `${String(error)}\n` } }))
          .then(async (settled) => {
            if (settled.kind === "failing" || settled.kind === "stopped") await handOver(sessionID)
            // The main agent's task end reports it, so nobody waits for these changes any more.
            if (settled.kind === "error") written.delete(sessionID)
            settling.delete(sessionID)
            if (!entry.awaited) await tellParent(sessionID, settled).catch((error) => console.error("[interlint]", error))
            await flushDeferred()
            return settled
          })
        settling.set(sessionID, entry)
        return entry
      }

      /**
       * Runs `checks` and, when they take longer than runningNoticeMs, tells the user in the session that they are
       * running. The result waits for the notice, up to RUNNING_NOTICE_WAIT_MS, so the two arrive in order. `noticed`
       * is false only when no notice was sent, or sending it failed.
       */
      const withRunningNotice = async (sessionID: string, checks: () => Promise<CheckRun>) => {
        let notice: Promise<boolean> | undefined
        const timer = setTimeout(() => {
          notice = ctx.session
            .synthetic({ sessionID, text: RUNNING_MESSAGE, description: RUNNING_MESSAGE, resume: false })
            .then(
              () => true,
              (error) => {
                console.error("[interlint] could not say the checks are running", error)
                return false
              },
            )
        }, runningNoticeMs)
        timer.unref?.()
        let run: CheckRun
        try {
          run = await checks()
        } finally {
          clearTimeout(timer)
        }
        if (notice === undefined) return { run, noticed: false }
        let waitTimer: ReturnType<typeof setTimeout> | undefined
        const gaveUp = new Promise<boolean>((resolve) => {
          waitTimer = setTimeout(() => resolve(true), RUNNING_NOTICE_WAIT_MS)
          waitTimer.unref?.()
        })
        const noticed = await Promise.race([notice, gaveUp]).finally(() => clearTimeout(waitTimer))
        return { run, noticed }
      }

      const onTurnEnd = async (sessionID: string) => {
        const { parent, ours } = await lookup(sessionID)
        if (!ours) return
        if (await isPaused(sessionID)) {
          written.delete(sessionID)
          if (parent) return
          undefer(sessionID)
          await ctx.session.synthetic({ sessionID, text: PAUSED_REMINDER, description: PAUSED_REMINDER, resume: false })
          return
        }
        if (parent) {
          // A subagent gets only the failures of the projects it changed, and none if it changed nothing.
          if (written.get(sessionID)?.size) settle(sessionID)
          return
        }
        if (running.has(sessionID)) return
        // The main agent's checks cover every changed project, its own files included, so none is left waiting.
        // A subagent taken for the main agent once, when its lookup failed, would otherwise defer the real one forever.
        written.delete(sessionID)
        // The failures of a subagent's changes are that subagent's to fix first. Marked before looking, so a subagent
        // that settles meanwhile finds it; if that flush took it, the flush runs the checks instead.
        deferred.add(sessionID)
        if (await hasUncheckedSubagent(sessionID)) return armDeferTimer(sessionID)
        if (!undefer(sessionID)) return
        running.add(sessionID)
        try {
          const context = await contextOf(sessionID)
          const { run, noticed } = await withRunningNotice(sessionID, () =>
            runChecks(directory, command, timeoutMs, TASK_END_ARGS, context),
          )
          const decision = gate.decide(sessionID, run)
          if (decision.action === "none") {
            if (noticed) {
              await ctx.session.synthetic({ sessionID, text: FINISHED_MESSAGE, description: FINISHED_MESSAGE, resume: false })
            }
            return
          }
          await ctx.session.synthetic({
            sessionID,
            text: decision.text,
            description: label(decision.text),
            resume: decision.action === "continue",
          })
        } finally {
          running.delete(sessionID)
        }
      }

      /** A subagent's turn failed or was interrupted: its parent answers for its unchecked changes. */
      const onTurnStopped = async (sessionID: string) => {
        const { parent, ours } = await lookup(sessionID)
        if (!ours || !parent || settling.has(sessionID)) return
        await handOver(sessionID)
        await flushDeferred()
      }

      /**
       * A deleted session never ends another turn. Its parent answers for its unchecked changes; when the parent
       * cannot be found any more, the main agent's checks, which cover every changed project, do.
       */
      const onDeleted = async (sessionID: string) => {
        const waiting = resumed.get(sessionID)
        if (waiting) {
          resumed.delete(sessionID)
          return waiting.resolve("interrupted")
        }
        if (settling.has(sessionID)) return
        if (lookups.get(sessionID)?.parent !== undefined) await handOver(sessionID)
        else written.delete(sessionID)
        await flushDeferred()
      }

      /** Holds a foreground subagent's answer until its checks pass, and says what happened. */
      const afterSubagent = async (event: ToolExecuted) => {
        const { sessionID: child, status } = event.result?.metadata ?? {}
        // A subagent in the background is still working: its turn end checks its changes and tells its parent.
        if (status !== "completed" || typeof child !== "string") return
        if (!settling.has(child) && !written.get(child)?.size) return
        if (await isPaused(event.sessionID)) return
        const entry = settle(child)
        entry.awaited = true
        const note = answerNote(await entry.done)
        if (note) event.result = withNote(event.result, note)
      }

      // OpenCode waits for this hook before it sends the tool result to the agent.
      const afterTool = await ctx.tool.hook("execute.after", async (event) => {
        if (event.status !== "completed") return
        // Only this project's edits are recorded, so a subagent it checks is always this project's.
        if (event.tool === SUBAGENT_TOOL) return await afterSubagent(event)
        const files = changedFiles(event.tool, event.input).filter((file) => {
          // A trailing backslash would escape the closing quote under sh.
          if (SHELL_SAFE_PATH.test(file) && !file.endsWith("\\")) return true
          console.error("[interlint] skipping a path the shell could misread:", file)
          return false
        })
        if (files.length === 0 || !(await isOurs(event.sessionID)) || (await isPaused(event.sessionID))) return
        record(event.sessionID, files)
        // So an approved edit renews a fingerprint that exists. Every session's, as looking up its main one may wait.
        await Promise.all(started.values())
        const lines = linesWritten(event.tool, event.input)
        const fileArgs = files.flatMap((file) => ["--file", file, "--lines", `${lines.get(file) ?? 0}`])
        // A subagent runs in its own session, and the protected files are kept for its main one.
        const root = knownRootOf(event.sessionID)
        const rootArgs = root === event.sessionID ? [] : ["--root-session", root]
        const args = ["check", "--when", "edit", ...rootArgs, ...fileArgs]
        const run = await runChecks(directory, command, editTimeoutMs, args, await contextOf(event.sessionID))
        const note = editNote(run)
        if (note) event.result = withNote(event.result, note)
        else if (run.exitCode !== 0) console.error("[interlint] the edit checks could not run:", run.output)
        // OpenCode Desktop shows only the diff of an edit, not its result: a message is what the user sees, whether the
        // checks passed or failed. Not awaited, so the agent does not wait for it, and it lands after the edit.
        const line = passedLine(run) ?? failedLine(run)
        if (line !== undefined) {
          ctx.session
            .synthetic({ sessionID: event.sessionID, text: line, description: line, resume: false })
            .catch((error) => console.error("[interlint]", error))
        }
      })

      /**
       * Keeps the protected files as they are when a main session's first turn starts, so its turn end can tell which
       * it changed. Once per session in this server: the CLI keeps the first fingerprint of a session anyway.
       */
      const onTurnStart = async (sessionID: string) => {
        if (started.has(sessionID)) return
        const { parent, ours } = await lookup(sessionID)
        if (parent !== undefined || !ours || started.has(sessionID) || paused.has(sessionID)) return
        const done = (async () => {
          const run = await runChecks(directory, command, editTimeoutMs, SESSION_START_ARGS, await contextOf(sessionID))
          if (run.exitCode !== 0) console.error("[interlint] could not keep the protected files:", run.output)
        })()
        started.set(sessionID, done)
        await done
      }

      // OpenCode evaluates the permission before the tool runs: a protected file makes it ask the user. An edit that
      // ran still never counts as approved: OpenCode Desktop 2.2.5 grants an `ask` without showing it, and the plugin
      // gets no event that tells a reply from that, so the CLI is never told the edit was asked about.
      let permissionHook: { dispose(): Promise<void> } | undefined
      try {
        permissionHook = await ctx.permission?.hook?.("evaluate", async (event) => {
          if (event.action !== EDIT_PERMISSION || event.effect === "deny") return
          const files = event.resources.filter((file) => SHELL_SAFE_PATH.test(file) && !file.endsWith("\\"))
          if (files.length === 0 || !(await isOurs(event.sessionID)) || (await isPaused(event.sessionID))) return
          const args = ["check", "--when", "pre-edit", ...files.flatMap((file) => ["--file", file])]
          const run = await runChecks(directory, command, editTimeoutMs, args)
          const question = run.exitCode === 0 ? run.output.trim() : ""
          if (question === "") return
          event.effect = "ask"
          event.message = question
        })
      } catch (error) {
        console.error("[interlint] could not ask before protected files change", error)
      }

      /**
       * Pauses or resumes Interlint in a main session and gives what the user reads. Resuming forgets the session's
       * blocks and unchecked changes, and the CLI restarts its state, so only what changes from now on is checked.
       */
      const markSession = async (sessionID: string, mark: "pause" | "resume"): Promise<string> => {
        if (mark === "pause") {
          if (paused.has(sessionID)) return PAUSED_MESSAGE
          paused.add(sessionID)
        } else {
          if (!paused.delete(sessionID)) return NOT_PAUSED_MESSAGE
          gate.reset(sessionID)
          for (const session of [...written.keys()]) if ((await rootOf(session)) === sessionID) written.delete(session)
          undefer(sessionID)
        }
        // Awaited, so a resume restarts the session's state before the agent's turn changes anything.
        const run = await runChecks(directory, command, editTimeoutMs, mark === "pause" ? PAUSE_ARGS : RESUME_ARGS, await contextOf(sessionID))
        if (run.exitCode !== 0) console.error(`[interlint] could not ${mark} the session in the CLI:`, run.output)
        return mark === "pause" ? PAUSED_MESSAGE : RESUMED_MESSAGE
      }

      // Only a main session's prompt is the user's: a subagent's is written by the agent that started it.
      let promptHook: { dispose(): Promise<void> } | undefined
      try {
        promptHook = await ctx.session.hook?.("prompt", async (event) => {
          const mark = pauseMark(event.prompt?.text)
          const { parent, ours } = await lookup(event.sessionID)
          if (parent !== undefined || !ours) return
          if (mark === undefined) {
            if (paused.has(event.sessionID)) return
            // Awaited, so the CLI takes the user's changes before the agent's turn changes anything.
            const run = await runChecks(directory, command, editTimeoutMs, TURN_START_ARGS, await contextOf(event.sessionID))
            if (run.exitCode !== 0) console.error("[interlint] could not start the turn in the CLI:", run.output)
            return
          }
          const text = await markSession(event.sessionID, mark)
          ctx.session
            .synthetic({ sessionID: event.sessionID, text, description: label(text), resume: false })
            .catch((error) => console.error("[interlint]", error))
        })
      } catch (error) {
        console.error("[interlint] could not read the pause marks in the user's prompts", error)
      }

      void (async () => {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const sessionID = event.data?.sessionID
          if (!sessionID) continue
          if (event.type === SESSION_DELETED) {
            models.delete(sessionID)
            onDeleted(sessionID).catch((error) => console.error("[interlint]", error))
            continue
          }
          const waiting = resumed.get(sessionID)
          if (event.type === TURN_START) {
            if (waiting) waiting.started = true
            else onTurnStart(sessionID).catch((error) => console.error("[interlint]", error))
            continue
          }
          const end = TURN_ENDS.get(event.type)
          if (end === undefined) continue
          if (waiting) {
            // A turn end before the resumed turn started belongs to the turn before it.
            if (waiting.started) {
              resumed.delete(sessionID)
              waiting.resolve(end)
            }
            continue
          }
          const handle = end === "succeeded" ? onTurnEnd(sessionID) : onTurnStopped(sessionID)
          handle.catch((error) => console.error("[interlint]", error))
        }
      })().catch((error) => {
        if (!controller.signal.aborted) console.error("[interlint]", error)
      })

      return () => {
        controller.abort()
        for (const timer of deferTimers.values()) clearTimeout(timer)
        void afterTool.dispose()
        void modelHook?.dispose()
        void promptHook?.dispose()
        void permissionHook?.dispose()
      }
    },
  }
}

/**
 * Whether `path` is `directory` or inside it. Both are compared as the real directories they name, so a symbolic
 * link or another spelling of the same directory still matches, ignoring a trailing separator and, on Windows, case.
 */
function isWithin(path: string, directory: string): boolean {
  const normal = (dir: string) => {
    const real = realDirectory(dir)
    return process.platform === "win32" ? real.toLowerCase() : real
  }
  const root = normal(directory)
  const target = normal(path)
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

/** The directory with its symbolic links resolved, or as written when it cannot be read. */
function realDirectory(dir: string): string {
  try {
    return realpathSync.native(dir)
  } catch {
    return resolvePath(dir)
  }
}

/** A model as OpenCode gives it, as the metrics keep it: its ID and provider, without its variant (decision 35). */
function modelOf(model: { id?: unknown; providerID?: unknown } | undefined): { model?: string; provider?: string } {
  const id = model?.id
  const provider = model?.providerID
  return {
    ...(typeof id === "string" && id !== "" ? { model: id } : {}),
    ...(typeof provider === "string" && provider !== "" ? { provider } : {}),
  }
}

/**
 * Runs the Interlint CLI. Through the shell, so Windows finds `interlint.cmd`. With a context, it adds
 * `--agent-context` and writes the context on its stdin, for the metrics.
 */
export function runInterlint(
  directory: string,
  command: string,
  timeoutMs: number,
  args: string[] = TASK_END_ARGS,
  context?: AgentContext,
): Promise<CheckRun> {
  return new Promise((resolve) => {
    let output = ""
    let truncated = false
    const append = (chunk: Buffer) => {
      if (truncated) return
      output += chunk.toString("utf8")
      if (output.length > MAX_OUTPUT_CHARS) {
        output = output.slice(0, MAX_OUTPUT_CHARS)
        truncated = true
      }
    }
    let timedOut = false
    const finish = (run: CheckRun) => {
      if (timedOut) return
      clearTimeout(timer)
      resolve(truncated ? { ...run, output: `${run.output}\n… output truncated by Interlint.\n` } : run)
    }

    // Arguments with other characters than these are quoted. File paths get here only if SHELL_SAFE_PATH accepts them.
    const all = context === undefined ? args : [...args, "--agent-context"]
    const line = [command, ...all.map((arg) => (/^[\w./:=-]+$/.test(arg) ? arg : `"${arg}"`))].join(" ")
    const child = spawn(line, {
      cwd: directory,
      shell: true,
      // Its own process group on POSIX, so a timeout can stop the whole build, not only the shell.
      detached: process.platform !== "win32",
      // OpenCode Desktop has no console, so without this Windows opens a console window on every run.
      windowsHide: true,
    })
    // A hung build must not keep the session marked as running: give up and report it.
    const timer = setTimeout(async () => {
      timedOut = true
      await killTree(child.pid)
      resolve({ exitCode: 2, output: `The checks did not finish within ${timeoutMs / 1000} s.\n` })
    }, timeoutMs)
    // A CLI that stopped before reading stdin closes the pipe: the checks' result does not depend on it.
    child.stdin.on("error", () => {})
    child.stdin.end(context === undefined ? "" : JSON.stringify(context))
    child.stdout.on("data", append)
    child.stderr.on("data", append)
    child.on("error", (error) => finish({ exitCode: 2, output: `${output}${error.message}\n` }))
    child.on("close", (code) => finish({ exitCode: code ?? 2, output }))
  })
}

/** Stops the shell and everything it started (the CLI, then Maven and its JVMs). */
function killTree(pid: number | undefined): Promise<void> {
  return new Promise((done) => {
    if (pid === undefined) return done()
    if (process.platform === "win32") {
      const taskkill = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
      taskkill.on("close", () => done())
      taskkill.on("error", () => done())
      return
    }
    try {
      process.kill(-pid, "SIGKILL")
    } catch {
      // Already gone.
    }
    done()
  })
}

export default createInterlintPlugin()
