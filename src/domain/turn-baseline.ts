/**
 * Between two turns of a session the user is at the keyboard: what changed since the agent's last turn ended, by a
 * `git pull` or by hand, is not the agent's to fix. A session's baselines take those changes as they are.
 */

/** Hashes keyed by a path or a directory, as the protected files' fingerprint and the resume baselines keep them. */
export type Hashes = Readonly<Record<string, string>>

/**
 * The baseline with each entry that differs between `turnEnd`, taken when the agent's last turn ended, and `now` set
 * as it is now: removed when it is gone. Entries that did not change since the turn ended stay as the baseline holds
 * them, so what the agent changed in its turn is still checked.
 */
export function withChangesBetweenTurns(baseline: Hashes, turnEnd: Hashes, now: Hashes): Record<string, string> {
  const renewed: Record<string, string> = { ...baseline }
  for (const key of new Set([...Object.keys(turnEnd), ...Object.keys(now)])) {
    const current = now[key]
    if (current === turnEnd[key]) continue
    if (current === undefined) delete renewed[key]
    else renewed[key] = current
  }
  return renewed
}
