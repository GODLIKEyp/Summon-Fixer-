# Backend remediation and frontend integration handoff

This change does not establish release readiness. No real-model acceptance run
was performed. The baseline was `60a2b82` on `integration/vertical-slice`.

## Filesystem application: deliberately unavailable (F04/F10)

The vulnerable pathname staging/rename implementation has been removed.
`replaceFileSafely` fails with HTTP 503 / `SAFE_WRITE_UNAVAILABLE` before opening
any target or staging file for writing. This is unconditional on all currently
supported Node hosts; there is no environment flag or browser override to enable
the old writer. Existing approval checks still run. Planning, rejection and Plan
Only remain available. Approval cannot currently apply a proposal automatically.

Why: an `lstat`/`realpath`/hash check followed by `rename` has a race. Exclusive
staging (`wx`) fixes only staging-name collisions. Directory-relative no-follow
operations fix pathname redirection but do not condition replacement on the
expected inode and bytes. Advisory locks do not exclude ordinary editors or
hostile processes. A swap-and-rollback can itself overwrite a later writer.
Node's portable filesystem API cannot provide the complete required transaction.

A future implementation must first establish enforceable exclusive ownership or
a supported transactional replacement primitive, and bind directory identity,
file identity, expected bytes and permission bits throughout the operation.
It must use exclusive staging and identity-bound cleanup. Do not reopen this
boundary with another pathname-only check or an undocumented cooperative lock.

Current preservation guarantees are fail-closed: no inode, bytes, modes or outside
sentinels are changed, including when the parent is swapped at the final boundary.
No staging file is created, so no staging cleanup is necessary. Tests that simulate
a successful storage boundary are explicitly labelled and test verification/state
handling only; they are not evidence of production application support.

## Suhani: additive interfaces (F09 and application availability)

`TaskState.application` is optional for backwards compatibility:

```ts
application?: {
  status: 'not_applied' | 'applied';
  appliedEditsCount: number;
}
```

New tasks start as `not_applied`, count 0. A successful writer changes it to
`applied`, count 1 before verification. If verification fails, task status is
`failed`, `error.code` is `VERIFICATION_FAILED`, `verification.status` is `failed`,
and `application` remains `applied`. The edit also remains `status: 'applied'`.
There is no unsafe automatic rollback. Existing completion semantics are unchanged.

Apply errors now include `{ error: { code, message }, task }` for a known task.
The bridge already forwards error bodies. The overlay should retain this state
or refetch the task, and not translate every non-2xx response into disconnection.
Precondition errors retain `PRECONDITION_FAILED` instead of generic `APPLY_FAILED`.

Engine `/health` adds `automaticApplyAvailable: false` and
`applicationUnavailableCode: 'SAFE_WRITE_UNAVAILABLE'`. The bridge currently
nests these in `engineDetails`. Disable automatic application with an explanation;
continue displaying and allowing review of proposals. Do not claim an update or
HMR occurred on an unavailable-application response.

No source-selection envelope change is made in this backend patch. The CLI
unknown-source integration expectation remains unchanged pending Suhani's
confirmed fail-closed bridge contract. Once confirmed, change that owned CLI test
to assert the exact rejection and zero spawned tasks. Its current acceptance is
a known frontend/bridge defect, not a security acceptance criterion.

## Proposal deadlines and diagnostics (F05)

CLI: `npm run summon -- dev --proposal-timeout-ms 90000`.
The default remains 60000 ms; valid values are integers from 1 to 600000 ms.
`proposalTimeoutMs` flows through runDev/startEngine/EngineServer/TaskExecutor
to CodexProposalInput. The executor also enforces the deadline for custom runners.
Shutdown/deadline abort signals terminate real managed processes; a custom runner
must honor the signal. Results arriving after abort cannot produce proposals.

Task logs contain only allowlisted stage names and elapsed/deadline milliseconds.
Stages include starting, spawned, first_output, first_event, proposal_received,
exited, completed and failed. No prompt, process environment, raw stdout/stderr,
provider errors, access tokens or model reasoning is logged. Prompts now travel
over stdin, not process argv. Auth/model settings are not overridden.

Evidence: both old E2E tests poll for 90 seconds while the real proposal process
used a hardcoded 60-second limit. One fixture is a tiny constants file; the other
is a larger demo App.tsx. Neither observation proves the deeper reason the demo
exceeded 60 seconds. Local CLI help/version confirmed `0.162.0-alpha.17.2`, stdin
prompt support and read-only sandbox selection without a model call.

Next authorized diagnostic run should compare binary version, workspace, chosen
local configuration (without credentials), spawn-to-first-output,
first-event-to-proposal and total durations across the two fixtures. Distinguish
auth/startup/network/provider delay from model work. Do not claim that choosing
another model or simply extending the deadline fixes the root cause.

Reference checked: https://learn.chatgpt.com/docs/non-interactive-mode

## Process containment limitations (F07)

POSIX children are placed in their own process group. Shutdown signals the group,
waits 250 ms, escalates to SIGKILL, then bounds direct-child exit confirmation to
750 ms. Descendants remaining in the group receive those signals, including when
the group leader has already exited. This is lifecycle management, not an OS
security sandbox: descendants that intentionally escape into another session
cannot be guaranteed terminated. Windows currently supports direct-child cleanup
only; full descendant containment requires a Job Object implementation.

Codex combined stdout/stderr is capped at 2 MiB; verification combined output at
1 MiB. Verification logs omit raw subprocess output. Private schema directories
are removed on success, malformed output, timeout, spawn failure and abort.
The Codex read-only flag is not a proof of the project's secret-read confinement.

## Proposed root-document corrections (not applied here)

- Describe the implemented packages, replacing the obsolete Phase 1A status.
- Use `npm install`, `npm run build`, then `npm run summon -- dev --fake` for
  model-free startup, or omit `--fake` only for an intentionally authorized model
  run with installed/authenticated Codex. `CODEX_BIN_PATH` selects a binary; the
  current fallback discovers the VS Code extension binary.
- Engine port defaults to 7890; `--port 0` requests an available port. There is no
  automatic fallback after a collision. Vite and engine ports are separate.
- Explain manual, one-existing-file proposals, disabled creation/deletion,
  disabled Auto Apply, and the current fail-closed automatic-application limit.
- Explain that verification failure does not mean the file was unchanged.
- `npm test` defaults to model-free operation. The two real-model suites require
  `SUMMON_RUN_REAL_CODEX_TESTS=1` and must only be run with explicit authorization.
  If enabled without a binary, they fail rather than silently passing.
- Current opt-in E2E assertions cover real proposal generation and rejection by
  the unavailable writer. A real successful apply/HMR acceptance test remains
  blocked until a safe storage backend exists; do not describe these as full
  successful-apply E2Es.
- JSX/TSX source selection is the implemented frontend integration; broader
  framework support and browser HMR must be verified by Suhani.

No shared root docs or Suhani-owned files are edited in this patch.
