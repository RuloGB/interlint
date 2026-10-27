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
 * - When a subagent's turn ends, it runs the task-end checks of the projects holding the files that subagent changed
 *   with an edit tool, and resumes the subagent with the failures, up to MAX_CONSECUTIVE_BLOCKS times. A subagent
 *   that changed no file, such as a read-only reviewer, runs nothing.
 * - OpenCode has no hook that keeps a session from ending, and the `subagent` tool returns the subagent's first answer.
 *   So the plugin holds that answer in the tool's `execute.after` hook until the subagent's checks pass, and adds
 *   what happened. If the subagent cannot fix them, the answer carries the failures to the agent that delegated
 *   the work, which answers for those files from then on. For a subagent in the background, a message does that.
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
/** Only the projects that changed since their checks last passed: a workspace may hold many. */
const TASK_END_ARGS = ["check", "--when", "task-end", "--changed"]
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

/** Whether the CLI ran and found failures. cmd.exe also exits with 1 when it cannot find the CLI, so exit 1 alone does not mean violations. */
function isReport(run: CheckRun): boolean {
  return run.exitCode === 1 && run.output.startsWith(REPORT_MARK)
}

/** The message that resumes an agent whose task-end checks failed. */
function blockText(attempt: number, output: string): string {
  return `Interlint: the task cannot end yet (attempt ${attempt} of ${MAX_CONSECUTIVE_BLOCKS}).\n\n${output}`
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

/** Decides what to do with a task-end check result. Keeps one block counter per session. */
export class TaskEndGate {
  private readonly blocks = new Map<string, number>()

  decide(sessionID: string, run: CheckRun): Decision {
    if (run.exitCode === 0) {
      this.blocks.delete(sessionID)
      return { action: "none" }
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
        text: `Interlint: the checks still fail after ${MAX_CONSECUTIVE_BLOCKS} attempts, so the task may end.\n\n${run.output}`,
      }
    }
    this.blocks.set(sessionID, attempt)
    return { action: "continue", text: blockText(attempt, run.output) }
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

/** The part of the OpenCode V2 plugin context this adapter uses. */
interface PluginContext {
  location: { directory: string }
  options?: { command?: unknown; timeoutMs?: unknown; editTimeoutMs?: unknown; subagentTimeoutMs?: unknown }
  session: {
    /**
     * A forked session has no `parentID`: only the sessions a subagent runs in have one. `location` is where the
     * session runs, which may be another project open in the same OpenCode.
     */
    get(input: { sessionID: string }): Promise<{ parentID?: string; location?: { directory?: unknown } }>
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
}

export type RunChecks = (directory: string, command: string, timeoutMs: number, args?: string[]) => Promise<CheckRun>

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
      const directory = ctx.location.directory
      const gate = new TaskEndGate()
      const running = new Set<string>()
      const controller = new AbortController()
      /** The files each session changed with an edit tool since its own task-end checks last passed. */
      const written = new Map<string, Set<string>>()
      /** What each session is to this plugin: its parent, and whether it runs in this plugin's project. */
      const lookups = new Map<string, { parent: string | undefined; ours: boolean }>()
      const settling = new Map<string, Settling>()
      /** The sessions Interlint resumed, waiting for the end of the turn that resume started. */
      const resumed = new Map<string, { started: boolean; resolve: (end: TurnEnd) => void }>()
      /** Main sessions whose turn end waited for a subagent with unchecked changes. */
      const deferred = new Set<string>()
      /** Ends the wait of a deferred main session after subagentTimeoutMs, per main session. */
      const deferTimers = new Map<string, ReturnType<typeof setTimeout>>()

      const lookup = async (sessionID: string) => {
        const known = lookups.get(sessionID)
        if (known) return known
        try {
          const { parentID, location } = await ctx.session.get({ sessionID })
          const parent = typeof parentID === "string" ? parentID : undefined
          // OpenCode runs the sessions of every open project in one server, and gives each plugin all their events.
          const where = location?.directory
          const ours = typeof where !== "string" || isWithin(where, directory)
          const session = { parent, ours }
          lookups.set(sessionID, session)
          return session
        } catch (error) {
          // Treated as this project's main agent: running its checks is better than not running them at all.
          console.error("[interlint] could not read session", sessionID, error)
          return { parent: undefined, ours: true }
        }
      }

      const parentOf = async (sessionID: string) => (await lookup(sessionID)).parent
      /** Whether the session runs in this plugin's project, so its changes are this project's to check. */
      const isOurs = async (sessionID: string) => (await lookup(sessionID)).ours

      const rootOf = async (sessionID: string) => {
        let session = sessionID
        for (let parent = await parentOf(session); parent !== undefined; parent = await parentOf(session)) session = parent
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
          const run = await runChecks(directory, command, timeoutMs, args)
          if (run.exitCode === 0) {
            written.delete(sessionID)
            return attempt === 1 ? { kind: "clean" } : { kind: "fixed" }
          }
          if (!isReport(run)) return { kind: "error", run }
          if (attempt > MAX_CONSECUTIVE_BLOCKS) return { kind: "failing", output: run.output }
          // Registered before the resume, so the turn it starts cannot end unseen.
          const turnEnd = new Promise<TurnEnd>((resolve) => resumed.set(sessionID, { started: false, resolve }))
          try {
            await ctx.session.synthetic({
              sessionID,
              text: subagentBlockText(attempt, run.output),
              description: "Interlint",
              resume: true,
            })
          } catch (error) {
            resumed.delete(sessionID)
            throw error
          }
          if ((await resumedTurnEnd(sessionID, turnEnd)) !== "succeeded") return { kind: "stopped", output: run.output }
        }
      }

      const tellParent = async (sessionID: string, settled: Settled) => {
        const note = parentNote(sessionID, settled)
        const parent = await parentOf(sessionID)
        if (!note || parent === undefined) return
        await ctx.session.synthetic({ sessionID: parent, text: note.text, description: "Interlint", resume: note.resume })
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

      const onTurnEnd = async (sessionID: string) => {
        const { parent, ours } = await lookup(sessionID)
        if (!ours) return
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
          const decision = gate.decide(sessionID, await runChecks(directory, command, timeoutMs, TASK_END_ARGS))
          if (decision.action === "none") return
          await ctx.session.synthetic({
            sessionID,
            text: decision.text,
            description: "Interlint",
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
        if (files.length === 0 || !(await isOurs(event.sessionID))) return
        record(event.sessionID, files)
        const args = ["check", "--when", "edit", ...files.flatMap((file) => ["--file", file])]
        const run = await runChecks(directory, command, editTimeoutMs, args)
        const note = editNote(run)
        if (note) event.result = withNote(event.result, note)
        else if (run.exitCode !== 0) console.error("[interlint] the edit checks could not run:", run.output)
      })

      void (async () => {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const sessionID = event.data?.sessionID
          if (!sessionID) continue
          if (event.type === SESSION_DELETED) {
            onDeleted(sessionID).catch((error) => console.error("[interlint]", error))
            continue
          }
          const waiting = resumed.get(sessionID)
          if (event.type === TURN_START) {
            if (waiting) waiting.started = true
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

/** Runs the Interlint CLI. Through the shell, so Windows finds `interlint.cmd`. */
export function runInterlint(
  directory: string,
  command: string,
  timeoutMs: number,
  args: string[] = TASK_END_ARGS,
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
    const line = [command, ...args.map((arg) => (/^[\w./:=-]+$/.test(arg) ? arg : `"${arg}"`))].join(" ")
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
