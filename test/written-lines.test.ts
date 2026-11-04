import { describe, expect, it } from "vitest"
import { writtenLines } from "../src/domain/written-lines.js"

describe("writtenLines", () => {
  it("counts every line of a new text", () => {
    expect(writtenLines("", "class Order {\n\n  int id;\n}\n")).toBe(4)
    expect(writtenLines("", "class Order {}")).toBe(1)
    expect(writtenLines("", "")).toBe(0)
  })

  it("counts only the lines an edit adds or changes, not the ones it keeps around them", () => {
    const before = "  void pay() {\n    charge();\n  }"
    const after = '  void pay() {\n    log.info("paying");\n    charge();\n  }'

    expect(writtenLines(before, after)).toBe(1)
  })

  it("counts a changed line once and a line removed by the edit as none", () => {
    expect(writtenLines("int a;\nint b;\nint c;", "int a;\nlong b;")).toBe(1)
  })

  it("counts each copy of a repeated line the edit adds", () => {
    expect(writtenLines("}", "}\n}\n}")).toBe(2)
  })

  it("reads Windows line endings as the same lines", () => {
    expect(writtenLines("a\r\nb\r\n", "a\nb\nc\n")).toBe(1)
  })
})
