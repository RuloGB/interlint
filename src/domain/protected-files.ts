/**
 * Protected files define the project's rules, such as ArchUnit tests or a linter's configuration. The agent may change
 * one only when the user approves it, so it never passes a check by weakening its rule (F23).
 */

/** `interlint.yaml`, protected even when `protected:` does not name it. */
export const ALWAYS_PROTECTED = "interlint.yaml"

/** The name of the protected files' check in the report and the metrics. */
export const PROTECTED_CHECK = "protected files"

/** Each protected file's content hash, keyed by its `/`-separated path relative to `interlint.yaml`. */
export type Fingerprint = Readonly<Record<string, string>>

/** The protected files that differ from a fingerprint taken before. A file new since then is not one. */
export interface ProtectedChanges {
  changed: string[]
  deleted: string[]
}

/** Every pattern that protects files: `interlint.yaml`, then those of `protected:`, each once. */
export function protectedPatterns(configured: readonly string[] = []): string[] {
  return [...new Set([ALWAYS_PROTECTED, ...configured])]
}

/** What changed between the fingerprint taken at session start and the one taken now, each sorted. */
export function protectedChanges(before: Fingerprint, now: Fingerprint): ProtectedChanges {
  const paths = Object.keys(before).sort()
  return {
    changed: paths.filter((path) => now[path] !== undefined && now[path] !== before[path]),
    deleted: paths.filter((path) => now[path] === undefined),
  }
}

export function hasProtectedChanges({ changed, deleted }: ProtectedChanges): boolean {
  return changed.length > 0 || deleted.length > 0
}

/**
 * The fingerprint taken before with the entries of the edited files as they are now: an approved edit makes them the
 * new reference. An edited file that matches a pattern and was not in it, such as one the edit created, is added.
 */
export function withApprovedEdits(before: Fingerprint, now: Fingerprint, edited: readonly string[]): Fingerprint {
  const renewed: Record<string, string> = { ...before }
  for (const path of Object.keys(now)) {
    if (edited.some((file) => samePath(file, path))) renewed[path] = now[path]!
  }
  return renewed
}

/** Whether `path`, `/`-separated and relative to `interlint.yaml`, matches one of the patterns. */
export function isProtected(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globPattern(pattern).test(normalized(path)))
}

/**
 * The pattern as a regular expression over a whole `/`-separated path, without case: `**` is any number of
 * directories, `*` any characters within one, `?` one character.
 */
export function globPattern(pattern: string): RegExp {
  const segments = normalized(pattern).split("/")
  let source = ""
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1
    if (segment === "**") {
      source += last ? ".*" : "(?:[^/]+/)*"
      return
    }
    source += [...segment]
      .map((char) => (char === "*" ? "[^/]*" : char === "?" ? "[^/]" : char.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
      .join("")
    if (!last) source += "/"
  })
  return new RegExp(`^${source}$`, "i")
}

/** The leading directories of a pattern before its first wildcard: where a walk for its files starts. */
export function patternBase(pattern: string): string {
  const segments = normalized(pattern).split("/")
  const base: string[] = []
  for (const segment of segments.slice(0, -1)) {
    if (/[*?]/.test(segment)) break
    base.push(segment)
  }
  return base.join("/")
}

/** Whether a pattern names one file, with no wildcard. */
export function isLiteral(pattern: string): boolean {
  return !/[*?]/.test(pattern)
}

/** A pattern or path `/`-separated, without `./` or empty segments. */
export function normalized(path: string): string {
  return path
    .split(/[\\/]/)
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/")
}

function samePath(a: string, b: string): boolean {
  return normalized(a).toLowerCase() === normalized(b).toLowerCase()
}

/**
 * For the agent: the protected files changed since the session started without the user's approval. `asks` tells
 * whether the agent's edit tool asks the user before it changes one.
 */
export function formatProtectedChanges({ changed, deleted }: ProtectedChanges, asks: boolean): string {
  const lines = [...changed.map((path) => `  ${path} (changed)`), ...deleted.map((path) => `  ${path} (deleted)`)]
  const how = asks
    ? "  If the task needs the change, make it with your edit tool: the user is asked to approve it."
    : "  If the task needs the change, ask the user whether they want it."
  return [
    `✗ ${PROTECTED_CHECK} · changed without the user's approval`,
    "",
    ...lines,
    "",
    "  These files define the project's rules. Undo the change: put each file back as it was.",
    how,
  ].join("\n")
}

/** For the agent, right after its edit tool changed protected files without asking the user first. */
export function formatProtectedEdit(files: readonly string[]): string {
  return [
    `✗ ${PROTECTED_CHECK} · this edit changed a file that defines the project's rules`,
    "",
    ...files.map((path) => `  ${path}`),
    "",
    "  Undo the change unless the user asked for it. The task cannot end while the file differs from how it was.",
  ].join("\n")
}

/** For the user, in the agent's permission prompt before it edits protected files. */
export function protectedEditQuestion(files: readonly string[]): string {
  return `Interlint: the agent wants to change ${files.join(", ")}, protected in interlint.yaml because it defines the project's rules. Allow it only if the task needs this change.`
}
