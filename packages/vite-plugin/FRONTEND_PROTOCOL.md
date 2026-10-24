# Frontend release-blocker integration handoff

Implemented on `fix/overlay-security`, initially at `e30b197`. Audit baseline `60a2b82` was not available in this checkout. No runner, CLI or contracts code was changed.

## Browser bridge authorization (F01)

The engine API and its bearer credential are unchanged. Browser callers now use a separate capability generated with 32 random bytes per Vite server lifetime. It is kept in the client instance, not localStorage or an injected script.

1. POST `/__summon/v1/session` from the configured Vite origin, with `Content-Type: application/json`, `X-Summon-Bootstrap: 1`, and `{}` as the body.
2. Receive `{ "capability": "<opaque capability>" }`. Do not log this value.
3. Send `X-Summon-Session: <capability>` on every other bridge request, including health and source resolution.
4. POST requests must have the exact Origin (scheme, hostname and actual listening port) and JSON content type. Same-origin browser GET may omit Origin; it still requires the capability and correct Host. Supplied Origin and Fetch Metadata are checked. Proxy forwarding headers never determine authority.
5. Bootstrap and API responses use `Cache-Control: no-store`. Cross-origin access is disabled in Vite's resolved server configuration because Vite 8 installs CORS before `configureServer`. A permissive project CORS setting is intentionally overridden. Actual bridge responses also remove CORS headers. Preflights are rejected.
6. Vite restarts rotate the capability. The client reports authorization failure without automatically replaying mutations. Reload the browser to reconnect.

A standalone `createBridgeMiddleware(options, registry, serverRoot, getAllowedOrigin)` caller must supply the fourth argument returning its trusted full listening origin. Omission fails closed (503 `ERR_BRIDGE_ORIGIN_UNAVAILABLE`). The plugin supplies this callback from server configuration and the actual bound port. Wildcard/non-loopback hosts and middleware-only servers without a listening address are unsupported.

For Node HTTP integration clients, explicitly send Origin for POSTs: Node fetch does not add the browser's Origin automatically. Bootstrap with the same headers as above, then use the returned capability. The engine token is never a browser capability.

| Condition | HTTP | `error.code` |
| --- | --- | --- |
| Missing/invalid browser capability | 401 | `ERR_SESSION_UNAUTHORIZED` |
| Wrong Host | 403 | `ERR_FORBIDDEN_HOST` (Vite may reject external Host first) |
| Missing mutation Origin, wrong origin, cross-site metadata, preflight | 403 | `ERR_FORBIDDEN_ORIGIN` |
| Missing bootstrap header | 403 | `ERR_SESSION_BOOTSTRAP` |
| Unsupported mutation media type | 415 | `ERR_UNSUPPORTED_CONTENT_TYPE` |

All these checks precede engine calls. Exact loopback hostname matters: `localhost` and `127.0.0.1` are not interchangeable origins.

## Selected-element source validation (F02, F12, F13)

The transform emits `data-summon-id`, `data-summon-rev`, and a display location on intrinsic JSX nodes. It uses the TypeScript parser already installed in this monorepo, preserving source maps and leaving generic TSX and component props untouched. The inspector carries ID/revision to the panel; it no longer fabricates IDs from React debug metadata.

Every task submitted through this browser bridge requires `context.sourceSelection.sourceId` and `revision`. This does not change the direct authenticated engine API. Paths in browser `targetFiles`, `activeFile`, or `relevantFiles` are replaced/cleared using the verified mapping. The bridge checks the file's current content hash as well as the registry revision.

| Selection problem | HTTP | `error.code` |
| --- | --- | --- |
| Missing selection | 400 | `ERR_SOURCE_REQUIRED` |
| Unknown or invalidated source ID | 404 | `ERR_SOURCE_NOT_FOUND` |
| Missing revision | 400 | `ERR_SOURCE_REVISION_REQUIRED` |
| Stale revision or changed disk content | 409 | `ERR_STALE_SOURCE_REVISION` |
| Source outside engine workspace | 403 | `ERR_SOURCE_OUTSIDE_WORKSPACE` |

Priyanshu: update the CLI test for unknown IDs to expect HTTP 404 with this JSON shape and **zero engine invocations**, rather than successful unscoped planning:

```json
{
  "error": {
    "code": "ERR_SOURCE_NOT_FOUND",
    "message": "Source mapping is unknown or invalidated. Re-select the element."
  }
}
```

CLI fixtures must write the same source bytes used for registration, pass its revision, and bootstrap bridge authorization. Existing direct-engine tests need no browser-session change.

## Proposal and failure-state expectations (F03, F08, F09)

The panel reviews one existing-file update with exact `oldContent` and `newContent` snippets. Empty replacement text is permitted. Patch-only, ambiguous, missing-content, mismatched-identity or oversized proposals cannot be approved. Both snippets are escaped, separately labeled as removals/additions, and bound to the displayed task ID, version, digest and content snapshot. Task version must equal proposal.taskVersion. Duplicate decisions for the same task/version/digest are suppressed, including after transport failures. No approval is automatically replayed.

Suhani confirmed the existing contract on October 24, 2026. The frontend uses:

- `task.edits[].status === "applied"` to establish a reported write.
- `task.verification.status === "failed"` plus an applied edit to display **"File modified, but verification failed."**
- `task.status` for lifecycle, never mutable UI mode for write status.
- An honest warning if write evidence is absent or inconsistent. It does not imply rollback from a failed HTTP response.

After an approval HTTP error the panel polls the same task to reconcile its authoritative state. Priyanshu should retain applied edit statuses and verification results on post-write failure. If the engine cannot guarantee these fields, integration must clarify the outcome; no new contract fields were invented here. Closing/reselecting invalidates pending UI responses, but does not cancel backend work. Backend cancellation remains unsupported.

## Verification scope and limits

The real-Vite suite starts temporary loopback Vite and fake HTTP engine instances. It verifies zero backend calls for unauthorized requests, successful authorized forwarding, source validation, the transform → inspector → panel → client → bridge path, and production exclusion. Renderer tests exercise production code with DOM fixtures; they do not assert visual layout or browser HMR. No real Codex process is started. Real-Codex proposal/approval/HMR acceptance still requires Suhani's observed browser run.
