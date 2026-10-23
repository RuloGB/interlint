# Interlint

A deterministic harness for AI coding agents. Interlint runs the checks your project **already has** (ArchUnit, Checkstyle, PMD…) as early as possible inside the agent's session, and makes the agent fix any violation in that same session before it moves on.

> **Status:** early design. Nothing is implemented yet.

## Why

Code rules usually live in two disconnected places:

- As text in `AGENTS.md`, which the agent may forget and nobody enforces.
- As checks (ArchUnit tests, Checkstyle, PMD), which the agent only hears about when someone builds or CI fails.

By then the fix comes late, outside the session, and by hand.

## How it works

- **After each edit:** fast checks run through the agent's post-edit hook, and failures go straight back to the agent.
- **At task end:** slower checks that need a full build run through the agent's stop hook. If they fail, the agent cannot finish until everything is green.

Interlint defines no rules and has no analysis engine of its own: your existing tools remain the single source of truth.

## Planned

- `interlint init`: detects the project's checks and generates `interlint.yaml`.
- `interlint check --when edit|task-end`: runs the matching checks and reports formatted failures.
- Thin adapters for Claude Code and OpenCode.
- Node/TypeScript CLI distributed through npm.
