# CLAUDE.md

This file provides operating instructions for Claude Code and AI pair-programming agents working in this repository.

## Authoritative Documentation

Refer to [AGENTS.md](AGENTS.md) for the authoritative specifications governing:
- Workspace architecture and documented package ownership boundaries (`packages/*`, `apps/*`).
- Security invariants and the permission model (`plan`, `manual`, `auto`).
- Multi-file editing contracts, proposal digest bindings, and base-content preconditions.
- Separation between untrusted browser requests and engine-owned state.

## Core Commands

- **Build**: `npm run build`
- **Typecheck**: `npm run typecheck`
- **Test**: `npm test`
- **Dependency Audit**: `npm audit`
- **Clean**: `npm run clean`

## Critical Operating Constraints

1. **Branch & Git Discipline**: Stay strictly on `main`. Do not create branches, switch branches, commit, or push unless explicitly authorized by the user.
2. **Preserve Untracked Assets**: Preserve the unexpected [#Summon-fixer](/#Summon-fixer) file and all unrelated repository assets.
3. **Milestone Scoping**: Do not implement the browser overlay, demo, CLI, Vite plugin, or Codex execution engine until their designated milestones.
4. **Contract vs Runtime Distinction**: Do not claim runtime enforcement has been implemented merely because schemas and types validate correctly in `@summon-fixer/contracts`.
