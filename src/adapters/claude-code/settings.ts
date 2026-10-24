import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { PlannedFile } from "../files/project-files.js"

/** The project's shared Claude Code settings, meant to be committed. */
export const SETTINGS_FILE = ".claude/settings.json"

interface InterlintHook {
  event: "PostToolUse" | "Stop"
  matcher?: string
  command: string
  /** Seconds. The edit one matches the OpenCode plugin's edit timeout; the stop one, Claude Code's default. */
  timeout: number
}

/** `Edit` and `Write` are the tools that change source files; `NotebookEdit` only changes notebooks. */
const HOOKS: InterlintHook[] = [
  { event: "PostToolUse", matcher: "Edit|Write", command: "interlint hook claude-code post-edit", timeout: 120 },
  { event: "Stop", command: "interlint hook claude-code stop", timeout: 600 },
]

export class SettingsError extends Error {}

type JsonObject = Record<string, unknown>

/** The project's Claude Code settings with Interlint's hooks added. Everything else in the file stays. */
export function claudeCodeSettingsFile(projectDir: string): PlannedFile {
  const path = join(projectDir, SETTINGS_FILE)
  const current = existsSync(path) ? readFileSync(path, "utf8") : undefined
  return { path: SETTINGS_FILE, content: withInterlintHooks(current), replace: true }
}

/**
 * Adds each hook unless it is already there with the same matcher and timeout. An Interlint hook
 * with the same command elsewhere is an older setup and is removed. Settings that need no change
 * keep their exact text, so a second `init` leaves the file as it is.
 */
export function withInterlintHooks(current: string | undefined): string {
  const settings = current === undefined || current.trim() === "" ? {} : parseSettings(current)
  const hooks = settings.hooks ?? {}
  if (!isObject(hooks)) throw new SettingsError(`${SETTINGS_FILE}: hooks is not an object`)

  let changed = current === undefined
  for (const hook of HOOKS) {
    const groups = hooks[hook.event] ?? []
    if (!Array.isArray(groups)) throw new SettingsError(`${SETTINGS_FILE}: hooks.${hook.event} is not a list`)
    if (groups.some((group) => isInstalled(group, hook))) continue

    const kept = groups.flatMap((group) => {
      if (!isObject(group) || !Array.isArray(group.hooks)) return [group]
      const others = group.hooks.filter((handler) => !(isObject(handler) && handler.command === hook.command))
      if (others.length === group.hooks.length) return [group]
      return others.length === 0 ? [] : [{ ...group, hooks: others }]
    })
    hooks[hook.event] = [
      ...kept,
      {
        ...(hook.matcher === undefined ? {} : { matcher: hook.matcher }),
        hooks: [{ type: "command", command: hook.command, timeout: hook.timeout }],
      },
    ]
    changed = true
  }
  if (!changed) return current as string
  settings.hooks = hooks
  return `${JSON.stringify(settings, null, 2)}\n`
}

function parseSettings(text: string): JsonObject {
  let value: unknown
  try {
    // Editors on Windows may save the file with a byte order mark, which JSON.parse rejects.
    value = JSON.parse(text.replace(/^﻿/, ""))
  } catch {
    throw new SettingsError(`${SETTINGS_FILE} is not valid JSON`)
  }
  if (!isObject(value)) throw new SettingsError(`${SETTINGS_FILE} is not a JSON object`)
  return value
}

function isInstalled(group: unknown, hook: InterlintHook): boolean {
  return (
    isObject(group) &&
    (group.matcher ?? "") === (hook.matcher ?? "") &&
    Array.isArray(group.hooks) &&
    group.hooks.some(
      (handler) =>
        isObject(handler) &&
        handler.type === "command" &&
        handler.command === hook.command &&
        handler.timeout === hook.timeout,
    )
  )
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
