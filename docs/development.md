# Development

Requires Node 22 or later. To use your build as the `interlint` on your `PATH`:

```bash
npm install && npm run build && npm link
```

| Command | What it does |
|---|---|
| `npm run build` | Removes `dist/` and compiles `src/` into it |
| `npm test` | Runs the tests. `test/package.test.ts` reads `dist/`, so build first |
| `npm run typecheck` | Type-checks `src/` and `test/` |
| `npm run test:pack` | Packs Interlint as npm would publish it and runs `npx interlint init` from that package, for each agent, in a clean Maven project outside the repository |

`npm pack` and `npm publish` build `dist/` first (`prepack`). The package holds only `dist/`, `docs/`, the OpenCode plugin, `README.md`, `LICENSE` and `package.json`.

`test:pack` installs Interlint's dependencies through `npx`. To use only the npm cache, run it with `npm_config_offline=true`.

## CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on every push to `main` and every pull request, on Linux, Windows and macOS with Node 22: `npm ci`, `typecheck`, `build`, `test` and `test:pack`. Any failing step fails the run.
