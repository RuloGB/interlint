import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { transcriptModel } from "../src/adapters/driven/agents/claude-code-transcript.js"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "interlint-transcript-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const assistant = (model: string) => JSON.stringify({ type: "assistant", message: { model, content: [] } })
const user = (text: string) => JSON.stringify({ type: "user", message: { content: text } })

function transcript(name: string, ...lines: string[]): string {
  const path = join(dir, name)
  writeFileSync(path, `${lines.join("\n")}\n`)
  return path
}

describe("transcriptModel", () => {
  it("gives the model of the last answer", () => {
    const path = transcript("s.jsonl", assistant("claude-sonnet-5-5"), user("hi"), assistant("claude-opus-5-5"), user("ok"))

    expect(transcriptModel({ path })).toBe("claude-opus-5-5")
  })

  it("skips the answers Claude Code writes itself", () => {
    const path = transcript("s.jsonl", assistant("claude-opus-5-5"), assistant("<synthetic>"))

    expect(transcriptModel({ path })).toBe("claude-opus-5-5")
  })

  it("finds an answer before lines much longer than one block it reads", () => {
    const path = transcript("s.jsonl", assistant("claude-haiku-5-5"), user("x".repeat(200_000)), user("y".repeat(70_000)))

    expect(transcriptModel({ path })).toBe("claude-haiku-5-5")
  })

  it("ignores a last line that is still being written", () => {
    const path = join(dir, "s.jsonl")
    writeFileSync(path, `${assistant("claude-opus-5-5")}\n{"type":"assistant","message":{"mod`)

    expect(transcriptModel({ path })).toBe("claude-opus-5-5")
  })

  it("reads a subagent's model from its own transcript", () => {
    const path = transcript("s.jsonl", assistant("claude-opus-5-5"))
    mkdirSync(join(dir, "s", "subagents"), { recursive: true })
    writeFileSync(join(dir, "s", "subagents", "agent-a1.jsonl"), `${assistant("claude-haiku-5-5")}\n`)

    expect(transcriptModel({ path, agentId: "a1" })).toBe("claude-haiku-5-5")
  })

  it("gives no model when the transcript is missing, has no answer, or has an answer without a model", () => {
    expect(transcriptModel({ path: join(dir, "missing.jsonl") })).toBeUndefined()
    expect(transcriptModel({ path: transcript("a.jsonl", user("hi")) })).toBeUndefined()
    expect(transcriptModel({ path: transcript("b.jsonl", JSON.stringify({ type: "assistant", message: {} })) })).toBeUndefined()
    expect(transcriptModel({ path: transcript("c.jsonl", assistant("claude-opus-5-5")), agentId: "gone" })).toBeUndefined()
  })
})
