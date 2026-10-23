# Summon Fixer: Architecture & Agent Guidelines

Summon Fixer is a project-local, Codex-powered development companion designed to bridge live web applications with intelligent local workspace code modification. It enables developers to inspect frontend UI elements, error boundaries, or terminal logs and summon an agent to plan, review, and apply multi-file fixes.

This document formalizes ownership boundaries, package responsibilities, permission models, security invariants, and operating standards for both human contributors and AI agents working on this repository.

---

## 1. Documented Ownership Boundaries

The repository is structured as an npm monorepo with `packages/*` and `apps/*`. Every package and application has strict architectural invariants and separation of concerns.

```
summon-fixer/
├── apps/                 # [Planned - Phase 2]  Demo applications and test harness host apps
├── packages/
│   ├── contracts/        # [Active - Phase 1A] Shared Zod schemas, TypeScript types, validation helpers
│   ├── runner/           # [Planned - Phase 1B] Local Codex engine, tool execution, AST & git diff generator
│   ├── overlay/          # [Planned - Phase 2]  Injected browser dev UI, DOM inspector, approval panel
│   ├── vite-plugin/      # [Planned - Phase 2]  Vite dev server plugin, middleware, overlay injector
│   └── cli/              # [Planned - Phase 2]  Developer CLI entrypoint, runner daemon controller
├── AGENTS.md             # Architecture, boundaries, and agent operating rules
├── CLAUDE.md             # Agent operating guide and constraints
├── README.md             # Project overview and setup instructions
├── package.json          # Monorepo root workspace configuration (packages/*, apps/*)
└── tsconfig.base.json    # Shared TypeScript compiler configuration
```

### Package Responsibilities & Boundaries

#### [packages/contracts/](packages/contracts/) (Active - Phase 1A)
- **Role**: Authoritative contract defining shared types, Zod schemas, real-time events, and validation helpers.
- **Ownership**: Core Contracts.
- **Invariants**:
  - Zero heavy or environment-specific dependencies (no Node-only APIs like `fs` or `child_process`; no DOM-specific dependencies).
  - Pure schemas and type inference using `zod`.
  - 100% backward compatibility. Schema updates must never silently break existing event or request payloads.
  - Exported through pure ESM with complete type declarations.
- **Allowed Consumers**: Imported by all packages ([packages/runner/](packages/runner/), [packages/overlay/](packages/overlay/), [packages/vite-plugin/](packages/vite-plugin/), [packages/cli/](packages/cli/)) and [apps/](apps/).

#### [packages/runner/](packages/runner/) (Planned - Phase 1B)
- **Role**: Local agent runtime that interfaces with OpenAI Codex / LLMs, analyzes workspace files, constructs multi-file diffs, and executes tasks.
- **Ownership**: Agent Runtime.
- **Invariants**:
  - Exclusively local execution: operates on project files within engine-resolved workspace boundaries.
  - Owns `TaskState`, authoritative `taskId`, `workspaceRoot`, and `effectivePolicy`.
  - Must strictly honor permission policies (`plan`, `manual`, `auto`).
  - Never directly mutates disk when in `plan` mode or before user confirmation in `manual` mode.
  - Applies diffs atomically using structured `MultiFileEditPlan`.
- **Allowed Consumers**: Consumed by [packages/cli/](packages/cli/) and [packages/vite-plugin/](packages/vite-plugin/).

#### [packages/overlay/](packages/overlay/) (Planned - Phase 2)
- **Role**: Client-side development overlay injected into the user's running browser application.
- **Ownership**: UI / DX.
- **Invariants**:
  - Untrusted client: submits `TaskRequest` with `requestId`, bounded prompt, and opaque `sourceId`/`revision`.
  - Strictly forbidden from dictating `permissionPolicy`, `allowedPaths`, `allowShellExecution`, or `workspaceRoot`.
  - Zero pollution of host app styles or DOM: must render inside isolated Shadow DOM or scoped containers.
  - Ultra-lightweight bundle size; zero heavy dependencies.
  - Communicates with runner exclusively via defined contract events ([packages/contracts/src/events.ts](packages/contracts/src/events.ts)).

#### [packages/vite-plugin/](packages/vite-plugin/) (Planned - Phase 2)
- **Role**: Developer tooling integration for Vite dev servers.
- **Ownership**: Tooling Integration.
- **Invariants**:
  - Injects overlay HTML/script during development mode only (`dev` mode; never in production builds).
  - Exposes local HTTP/WebSocket middleware connecting browser overlay to local runner.

#### [packages/cli/](packages/cli/) (Planned - Phase 2)
- **Role**: Terminal command-line interface for Summon Fixer.
- **Ownership**: CLI Tooling.
- **Invariants**:
  - Handles daemon lifecycle, environment checks, and CLI flags.

---

## 2. Separation of Untrusted Browser Input vs Engine Authority

To guarantee security in development environments, Summon Fixer strictly separates client-side requests from engine authority:

1. **Untrusted `TaskRequest`**:
   - Contains a client-assigned `requestId` (1-128 chars) and optional `idempotencyKey`.
   - Contains a bounded user prompt (1-10,000 characters, whitespace-only rejected).
   - Contains optional context with opaque `sourceId` and `revision` selection.
   - May state a `requestedMode` (`plan`, `manual`, `auto`), but **cannot** supply `permissionPolicy`, cannot specify `allowedPaths`, cannot enable `allowShellExecution`, and cannot specify `workspaceRoot`.
2. **Engine-Owned `TaskState`**:
   - The runner assigns the authoritative `taskId` and increments a monotonic `version` counter.
   - The runner resolves the true `workspaceRoot` on the host machine.
   - The runner computes the `effectivePolicy` based on local project configuration.

---

## 3. Permission Model & Security Invariants

Summon Fixer contracts model three distinct permission modes defined in [packages/contracts/src/permissions.ts](packages/contracts/src/permissions.ts):

| Mode | Autonomy Level | Disk Modification | Shell Execution | Approval Gate |
| :--- | :--- | :--- | :--- | :--- |
| `plan` | Read-only analysis | Strictly forbidden | Strictly forbidden | Required |
| `manual` | Interactive assistance | Permitted upon explicit approval | Controlled | Required per changeset/action |
| `auto` | Autonomous execution | Permitted within path & file limits | Restricted sandbox | Automated within policy limits |

### Security Invariants & Secret Protection
1. **Protected Secrets**: Files matching `.env` and all `.env.*` patterns (such as `.env.local`, `.env.production`, `.env.staging`) are strictly disallowed by policy. As an explicit exception, `.env.example` is permitted for reading and template creation.
2. **Path Traversal Containment**: All edit targets are normalized. Any path containing `..` or leading `/` is rejected.
3. **Immutable Baseline Configuration**: Baseline permission policies (`DEFAULT_PERMISSION_POLICIES`) are deeply frozen. Helper functions return deep clones (`structuredClone`) to prevent runtime configuration poisoning.

---

## 4. Proposal Digest Binding & Multi-File Editing Contracts

Summon Fixer enforces rigorous proposal integrity in [packages/contracts/src/edits.ts](packages/contracts/src/edits.ts):

- **Deterministic Proposal Digest**: Every proposal (`MultiFileEditPlan`) computes a canonical SHA-256 hash (`proposalDigest`) over sorted, normalized file edits and the active `taskVersion`.
- **Stale Approval Rejection**: User approvals (`EditApprovalResponse`) must match both the active `taskVersion` and the immutable `proposalDigest`. If the proposal has mutated or the version has incremented, the approval is rejected.
- **Base-Content Preconditions**: Proposals include `BaseContentPrecondition` entries specifying expected file hashes (`expectedHash`) to prevent applying edits to files that have changed concurrently on disk.
- **Rejection of Contradictory & Malformed Edits**:
  - `create`: Must provide non-null `newContent`; cannot provide non-null `oldContent`.
  - `delete`: Cannot provide non-null `newContent`.
  - `update`: Must provide `newContent` or `patch`; cannot have identical `oldContent` and `newContent` (no-op rejection).
  - Duplicate normalized paths (e.g., `src/a.ts` and `./src/a.ts`) are rejected.
  - Inconsistent counts (`totalFiles !== edits.length`) are rejected.

---

## 5. Task State Transitions, Preflight Failures & Outcomes

Task lifecycle transitions are strictly governed in [packages/contracts/src/validators.ts](packages/contracts/src/validators.ts):

- **Preflight Failure**: Tasks can fail directly during preflight checks from `queued` or `planning` to `failed` with structured error categories (`preflight`, `policy`, `execution`, `timeout`, `internal`).
- **Read-Only Completion**: In `plan` mode or for informational queries, tasks can transition directly from `planning` to `completed` without executing edits.
- **Typed Outcomes**:
  - `CompletionOutcome`: Distinguishes `edits_applied`, `read_only`, and `no_op`.
  - `VerificationOutcome`: Records typed results (`passed`, `failed`, `skipped`) for linters, typechecks, or test runners.
- **Idempotency Semantics**: When an `idempotencyKey` is provided, the engine deduplicates incoming requests, guaranteeing that duplicate network submissions do not spawn multiple agent tasks.

---

## 6. Operating Rules for AI Agents

When acting as an AI agent (such as Claude Code) pair-programming in this repository, observe the following rules:

1. **Honor Milestone Scope**:
   - Do not implement components ahead of schedule (e.g., overlay, CLI, or Codex runner in Phase 1A). Keep implementation laser-focused on the active milestone.
2. **Preserve Untracked & User Assets**:
   - Never delete or modify unexpected files such as [#Summon-fixer](/#Summon-fixer) or existing [README.md](README.md) contents unless explicitly requested by the user.
3. **Contract vs Runtime Enforcement**:
   - Do not claim runtime enforcement has been implemented merely because contracts and Zod schemas validate correctly. Contracts define and validate data structures; engine runtime enforcement occurs in Phase 1B.
4. **Git Discipline**:
   - Work strictly on `main`.
   - Do not create branches, switch branches, commit, or push unless explicitly requested by the user.
5. **Verification**:
   - Always run `npm run build`, `npm run typecheck`, `npm test`, `npm audit`, and `git diff --check` to verify changes before marking any task complete.
