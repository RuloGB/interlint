/** `part / whole` with `digits` decimals, or `-` when there is no whole. */
export function ratio(part: number, whole: number, digits: number): string {
  return whole === 0 ? "-" : (part / whole).toFixed(digits)
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

export function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

/** A duration as people read it: `4.5s`, `2m 5s`, `1h 3m`. */
export function duration(ms: number): string {
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const whole = Math.round(seconds)
  if (whole < 3600) return `${Math.floor(whole / 60)}m ${whole % 60}s`
  return `${Math.floor(whole / 3600)}h ${Math.floor((whole % 3600) / 60)}m`
}
