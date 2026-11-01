import { defineConfig } from "vitest/config"

/** Only this repository's tests: copies of it elsewhere in the tree, such as agent worktrees in `.claude/`, are not. */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
})
