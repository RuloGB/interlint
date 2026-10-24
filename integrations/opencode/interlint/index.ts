/**
 * Interlint adapter for OpenCode V2.
 *
 * When an agent turn ends (`session.execution.succeeded`), it runs `interlint check --when task-end`.
 * If a check fails, it resumes the session with the formatted failures so the agent fixes them,
 * up to MAX_CONSECUTIVE_BLOCKS times in a row.
 *
 * `session.idle` is not used: in OpenCode 2.1.4 it never reaches a plugin's event subscription.
 *
 * Install: copy this directory to `.opencode/plugins/interlint/` in the project.
 * The file has no runtime imports besides Node built-ins: `Plugin.define` from `@opencode/plugin`
 * is the identity function, so the plain definition below is equivalent.
 */
import { spawn } from "node:child_process"

export const MAX_CONSECUTIVE_BLOCKS = 3
/** Keeps the text injected into the session bounded, like the CLI does with build output. */
export const MAX_OUTPUT_CHARS = 64 * 1024
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

const TURN_END = "session.execution.succeeded"
/** Every report the Interlint CLI prints starts with this mark. */
const REPORT_MARK = "✗ "

export interface CheckRun {
  exitCode: number
  output: string
}

export type Decision = { action: "none" } | { action: "continue"; text: string } | { action: "report"; text: string }

/** Decides what to do with a task-end check result. Keeps one block counter per session. */
export class TaskEndGate {
  private readonly blocks = new Map<string, number>()

  decide(sessionID: string, run: CheckRun): Decision {
    if (run.exitCode === 0) {
      this.blocks.delete(sessionID)
      return { action: "none" }
    }
    // cmd.exe also exits with 1 when it cannot find the CLI, so exit 1 alone does not mean violations.
    if (run.exitCode !== 1 || !run.output.startsWith(REPORT_MARK)) {
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
    return {
      action: "continue",
      text: `Interlint: the task cannot end yet (attempt ${attempt} of ${MAX_CONSECUTIVE_BLOCKS}).\n\n${run.output}`,
    }
  }
}

/** The part of the OpenCode V2 plugin context this adapter uses. */
interface PluginContext {
  location: { directory: string }
  options?: { command?: unknown; timeoutMs?: unknown }
  session: {
    synthetic(input: { sessionID: string; text: string; description?: string; resume?: boolean }): Promise<unknown>
  }
  event: {
    subscribe(input: { signal: AbortSignal }): AsyncIterable<{ type: string; data?: { sessionID?: string } }>
  }
}

export type RunChecks = (directory: string, command: string, timeoutMs: number) => Promise<CheckRun>

export function createInterlintPlugin(runChecks: RunChecks = runInterlint) {
  return {
    id: "interlint",
    async setup(ctx: PluginContext) {
      const command = typeof ctx.options?.command === "string" ? ctx.options.command : "interlint"
      const timeoutMs = typeof ctx.options?.timeoutMs === "number" ? ctx.options.timeoutMs : DEFAULT_TIMEOUT_MS
      const gate = new TaskEndGate()
      const running = new Set<string>()
      const controller = new AbortController()

      const onTurnEnd = async (sessionID: string) => {
        if (running.has(sessionID)) return
        running.add(sessionID)
        try {
          const decision = gate.decide(sessionID, await runChecks(ctx.location.directory, command, timeoutMs))
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

      void (async () => {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const sessionID = event.data?.sessionID
          if (event.type !== TURN_END || !sessionID) continue
          onTurnEnd(sessionID).catch((error) => console.error("[interlint]", error))
        }
      })().catch((error) => {
        if (!controller.signal.aborted) console.error("[interlint]", error)
      })

      return () => controller.abort()
    },
  }
}

/** Runs the Interlint CLI. Through the shell, so Windows finds `interlint.cmd`. */
export function runInterlint(directory: string, command: string, timeoutMs: number): Promise<CheckRun> {
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

    const child = spawn(`${command} check --when task-end`, {
      cwd: directory,
      shell: true,
      // Its own process group on POSIX, so a timeout can stop the whole build, not only the shell.
      detached: process.platform !== "win32",
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
      const taskkill = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" })
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
