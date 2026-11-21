import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { type AgentFiles, AgentSetupError } from "../../../application/setup/ports.js"

/** The project's shared Claude Code settings, meant to be committed. */
export const SETTINGS_FILE = ".claude/settings.json"

/** A hook in the format Claude Code and Codex share: matcher groups of handlers, keyed by event. */
export interface InterlintHook {
  event: "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop" | "SubagentStart" | "SubagentStop"
  matcher?: string
  command: string
  /** Seconds. The edit one matches the OpenCode plugin's edit timeout; the stop ones give Maven time. */
  timeout: number
  /** Shown to the user while the hook runs, for the hooks that run checks. */
  statusMessage?: string
}

/** The text the agent shows while a hook runs the checks, so the user knows the task has not ended yet. */
export const RUNNING_CHECKS = "Interlint: running checks"

/**
 * `Edit` and `Write` are the tools that change source files; `NotebookEdit` only changes notebooks.
 * `Stop` fires for the main agent only; a subagent fires `SubagentStop`, so it gets the failures of its own changes,
 * including those made through a shell command, which `SubagentStart` lets it tell apart. `SessionStart` keeps the protected files as they are, and `PreToolUse` asks the user before an edit changes one.
 * `UserPromptSubmit` reads `interlint: pause` and `interlint: resume` in the user's prompt.
 */
const HOOKS: InterlintHook[] = [
  { event: "SessionStart", command: "interlint hook claude-code session-start", timeout: 30 },
  { event: "UserPromptSubmit", command: "interlint hook claude-code user-prompt", timeout: 120 },
  { event: "PreToolUse", matcher: "Edit|Write", command: "interlint hook claude-code pre-edit", timeout: 30 },
  { event: "PostToolUse", matcher: "Edit|Write", command: "interlint hook claude-code post-edit", timeout: 120, statusMessage: RUNNING_CHECKS },
  { event: "Stop", command: "interlint hook claude-code stop", timeout: 600, statusMessage: RUNNING_CHECKS },
  { event: "SubagentStart", command: "interlint hook claude-code subagent-start", timeout: 30 },
  {
    event: "SubagentStop",
    command: "interlint hook claude-code subagent-stop",
    timeout: 600,
    statusMessage: RUNNING_CHECKS,
  },
]

type JsonObject = Record<string, unknown>

/** The project's Claude Code settings with Interlint's hooks added. Everything else in the file stays. */
export const claudeCodeSettingsFiles: AgentFiles = (projectDir) => {
  const path = join(projectDir, SETTINGS_FILE)
  const current = existsSync(path) ? readFileSync(path, "utf8") : undefined
  return [{ path: SETTINGS_FILE, content: withInterlintHooks(current, SETTINGS_FILE, HOOKS), replace: true }]
}

/**
 * Leaves each hook once: the first handler with the same command, matcher, timeout and status message stays,
 * every other handler with that command is an older setup or a copy and is removed, and the hook
 * is added when none was the same. Settings that need no change keep their exact text, so a second
 * `init` leaves the file as it is.
 */
export function withInterlintHooks(current: string | undefined, file: string, interlintHooks: readonly InterlintHook[]): string {
  const settings = current === undefined || current.trim() === "" ? {} : parseSettings(current, file)
  const hooks = settings.hooks ?? {}
  if (!isObject(hooks)) throw new AgentSetupError(`${file}: hooks is not an object`)

  let changed = current === undefined
  for (const hook of interlintHooks) {
    const groups = hooks[hook.event] ?? []
    if (!Array.isArray(groups)) throw new AgentSetupError(`${file}: hooks.${hook.event} is not a list`)

    let installed = false
    let removed = false
    const kept = groups.flatMap((group) => {
      if (!isObject(group) || !Array.isArray(group.hooks)) return [group]
      const handlers = group.hooks.filter((handler) => {
        if (!isObject(handler) || handler.command !== hook.command) return true
        if (!installed && isInstalled(group, handler, hook)) return (installed = true)
        removed = true
        return false
      })
      if (handlers.length === group.hooks.length) return [group]
      return handlers.length === 0 ? [] : [{ ...group, hooks: handlers }]
    })
    if (!installed) {
      kept.push({
        ...(hook.matcher === undefined ? {} : { matcher: hook.matcher }),
        hooks: [
          {
            type: "command",
            command: hook.command,
            timeout: hook.timeout,
            ...(hook.statusMessage === undefined ? {} : { statusMessage: hook.statusMessage }),
          },
        ],
      })
    }
    if (installed && !removed) continue
    hooks[hook.event] = kept
    changed = true
  }
  if (!changed) return current as string
  settings.hooks = hooks
  return `${JSON.stringify(settings, null, 2)}\n`
}

function parseSettings(text: string, file: string): JsonObject {
  let value: unknown
  try {
    // Editors on Windows may save the file with a byte order mark, which JSON.parse rejects.
    value = JSON.parse(text.replace(/^﻿/, ""))
  } catch {
    throw new AgentSetupError(`${file} is not valid JSON`)
  }
  if (!isObject(value)) throw new AgentSetupError(`${file} is not a JSON object`)
  return value
}

/** Whether `handler`, in `group`, is `hook` exactly as `init` writes it. */
function isInstalled(group: JsonObject, handler: JsonObject, hook: InterlintHook): boolean {
  return (
    (group.matcher ?? "") === (hook.matcher ?? "") &&
    handler.type === "command" &&
    handler.command === hook.command &&
    handler.timeout === hook.timeout &&
    handler.statusMessage === hook.statusMessage
  )
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
