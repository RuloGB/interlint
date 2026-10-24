import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parse } from "yaml"
import { type Check, type Config, REPORTS, WHENS } from "../../core/check.js"

export const CONFIG_FILE = "interlint.yaml"

export class ConfigError extends Error {}

export function loadConfig(projectDir: string): Config {
  const path = join(projectDir, CONFIG_FILE)
  if (!existsSync(path)) throw new ConfigError(`${CONFIG_FILE} not found in ${projectDir}`)

  const text = readFileSync(path, "utf8")
  let raw: unknown
  try {
    raw = parse(text)
  } catch (error) {
    throw new ConfigError(`${CONFIG_FILE} is not valid YAML: ${(error as Error).message}`)
  }

  const checks = isRecord(raw) ? raw.checks : undefined
  if (!Array.isArray(checks) || checks.length === 0) {
    throw invalid("checks must be a non-empty list")
  }

  const parsed = checks.map((entry, index) => parseCheck(entry, `checks[${index}]`))
  assertUniqueNames(parsed)
  return { checks: parsed }
}

function parseCheck(entry: unknown, at: string): Check {
  if (!isRecord(entry)) throw invalid(`${at} must be a mapping with name, run, report and when`)
  return {
    name: requireString(entry, "name", at),
    run: requireString(entry, "run", at),
    report: requireOneOf(entry, "report", REPORTS, at),
    when: requireOneOf(entry, "when", WHENS, at),
  }
}

function requireString(entry: Record<string, unknown>, field: string, at: string): string {
  const value = entry[field]
  if (typeof value !== "string" || value.trim() === "") {
    throw invalid(`${at}.${field} must be a non-empty string`)
  }
  return value
}

function requireOneOf<T extends string>(
  entry: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
  at: string,
): T {
  const value = requireString(entry, field, at)
  if (!(allowed as readonly string[]).includes(value)) {
    throw invalid(`${at}.${field} must be one of: ${allowed.join(", ")} (got "${value}")`)
  }
  return value as T
}

function assertUniqueNames(checks: Check[]) {
  const seen = new Map<string, number>()
  checks.forEach((check, index) => {
    const first = seen.get(check.name)
    if (first !== undefined) {
      throw invalid(`checks[${index}].name "${check.name}" is already used by checks[${first}]`)
    }
    seen.set(check.name, index)
  })
}

function invalid(detail: string) {
  return new ConfigError(`${CONFIG_FILE}: ${detail}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
