# MCP server

The board's MCP endpoint (`POST /api/mcp`): a stateless Streamable HTTP server whose tools call the board's own routes in-process as the connected person.

| Concern | Code | Test |
| --- | --- | --- |
| Transport, hijack and stream, abort wiring, body limit, 2024-11-05 refusal | `server/src/mcp/routes.ts`, `server/src/mcp/pipe.ts` | `server/test/mcp.transport.test.ts` |
| Origin/Host policy, the auth gate (`enforceMcp`), `MCP_ENABLED` | `server/src/mcp/origin.ts`, `server/src/auth/plugin.ts`, `server/src/config-mcp.ts` | `server/test/mcp.transport.test.ts`, `server/test/config.mcp.test.ts` |
| The in-process caller: `app.inject` with the caller on the request class, one deadline, an abort signal | `server/src/mcp/bridge.ts`, `server/src/auth/bridge-binding.ts` | `server/test/mcp.bridge.test.ts` |
| Result mapping: 2xx data, board refusal with its own code, everything else `inconclusive` | `server/src/mcp/result.ts` | `server/test/mcp.result-mapping.test.ts` |
| Adding a tool: `defineTool` in `server/src/mcp/tools/<name>.ts`, added to `TOOLS` in `registry.ts`; `routes` names each backing route, `output` is required, a destructive tool takes `DESTRUCTIVE` and `confirm: true` | `server/src/mcp/tool.ts`, `server/src/mcp/registry.ts` | `server/test/mcp.registry.test.ts` |
| The static tool list (batch tools omitted while `BATCHES_ENABLED` is off), scope check, `confirm`, per-caller cap, metrics, one server per request | `server/src/mcp/registry.ts`, `server/src/mcp/server.ts` | `server/test/mcp.registry.test.ts` |
| The authorization server a client discovers from the 401 challenge ([auth.md](auth.md)) | `server/src/routes/oauth.ts`, `server/src/routes/oauth-http.ts`, `server/src/routes/oauth-register.ts` | `server/test-db/oauth.sdk-flow.test.ts`, `server/test-db/oauth.client-registration.test.ts` |
| The consent screen and the connected-apps panel ([design-system/entry.md](design-system/entry.md)) | `web/src/pages/OAuthConsentPage.tsx`, `web/src/panels/ConnectedAppsPanel.tsx`, `server/src/routes/oauth-grants.ts` | `web/test/OAuthConsent.dom.test.tsx`, `web/test/ConnectedAppsPanel.dom.test.tsx`, `e2e/oauth-consent.spec.ts`, `server/test-db/routes.oauth-grants.test.ts` |
| Discovery and preflight tools (`factory:read`): a repo list with a refresh error is `stale` | `server/src/mcp/tools/discovery.ts`, `server/src/mcp/tools/skills.ts`, `server/src/mcp/tools/connections.ts`, `server/src/mcp/tools/preflight.ts` | `server/test/mcp.tools-discovery.test.ts` |
| Task, job, log, question and detail tools (`factory:read`): one shared run `state`, a half-failed composite read is `inconclusive`, a vanished `read_job_log` chunk is `inconclusive`, never a skip, a gate not known to have passed is never a pass | `server/src/mcp/tools/{run-state,tasks,runs,logs,task-detail}.ts` | `server/test/mcp.tools-jobs.test.ts`, `server/test-db/mcp.tools-jobs.test.ts` |
| `wait_task`: a bounded wait (default 45 s, at most 55 s, 3 s headroom), verdict mapped as `bellows job wait` maps it, a board `parked` poll being `needs_attention` whatever the head reads; the loop in `bounded-wait.ts` is generic over what settles | `server/src/mcp/bounded-wait.ts`, `server/src/mcp/tools/task-wait.ts` | `server/test/mcp.bounded-wait.test.ts`, `server/test/mcp.wait-task.test.ts` |
| Task write tools (`factory:write`): one board route each, refusals verbatim; `stop_task`, `force_close_task` and `remove_task` need `confirm: true`, checked before any inject; `answer_question` also needs `factory:read` | `server/src/mcp/tools/task-writes.ts` | `server/test/mcp.tools-write.test.ts`, `server/test-db/mcp.tools-write.test.ts` |
| Batch tools: plan and read, wait, control ([batches.md](batches.md)); `standing` is the board's, never computed here; `cancel_batch` needs `confirm: true` | `server/src/mcp/tools/batches.ts`, `server/src/mcp/tools/batch-wait.ts`, `server/src/mcp/tools/batch-tasks.ts` | `server/test/mcp.tools-batch.test.ts`, `server/test/mcp.wait-batch.test.ts`, `server/test-db/mcp.tools-batch.test.ts` |
| Attachment handoff (`create_attachment_upload`; the registry is 40 tools): a single-use, 15-minute upload link, never file bytes | `server/src/mcp/tools/attachments.ts`, `server/src/routes/attachment-uploads.ts`, `server/src/attachments/upload-capability-store.ts`, `server/migrations/124_attachment_upload.sql` | `server/test/mcp.attachment-upload.test.ts`, `server/test-db/mcp.attachment-handoff.test.ts`, `web/test/AttachmentUploadPage.dom.test.tsx`, `e2e/attachment-upload.spec.ts` |
| Which routes a scoped caller may reach, and which open routes a bridged call may | `server/src/auth/route-class.ts` | `server/test/auth.enforcement.test.ts`, `server/test/auth.me-bridged.test.ts` |
| End to end: a real SDK client through consent and a task to its end; the 40-tool registry snapshot; the chart's https-only gate | `e2e/mcp-connect.spec.ts`, `scripts/mcp-phase-client.mjs`, `scripts/mcp-kind-client.mjs`, `charts/factory/templates/validate.yaml` | `server/test/mcp.registry-snapshot.test.ts`, `scripts/test-jobs.sh` (`--phase mcp`), `scripts/test-k8s.sh` (`mcp` phase) |
| `factory_mcp_tool_duration_seconds{tool,outcome}` | `server/src/metrics.ts` | `server/test/mcp.whoami.test.ts` |

## Connecting a client

`https://<board host>/api/mcp`; a client finds the authorization server from the 401 challenge, registers by CIMD or DCR, and the member approves on the consent screen. Working references: `e2e/mcp-connect.spec.ts`, `scripts/mcp-phase-client.mjs`. Claude Code: `claude mcp add --transport http factory https://<board host>/api/mcp`, then `/mcp` to authenticate.

- **Known to work:** the SDK v2 client on `2026-07-28`, run through consent to a finished task by the e2e suite and
  the docker lane (`e2e/mcp-connect.spec.ts`, `scripts/test-jobs.sh --phase mcp`). Legacy `initialize` clients on
  `2025-11-25` and `2025-06-18` are served by the same route (`server/test/mcp.transport.test.ts`).
- **Stated limit: headless Claude Code is not run by any lane.** The connect commands above are the supported path, unverified in CI.
- **Stated limit: GUI clients are unverified.** claude.ai and Claude Desktop custom connectors, Cursor and VS Code
  Copilot were never run against this server by a person; what is known of them is from their source, vendor docs or
  the defaults here. Check a real connector before relying on one. `core/test/docs.mcp.test.ts` pins this sentence.
- **Stated limit: no file bytes through MCP.** A GUI client cannot send a local file, so `create_attachment_upload`
  returns a page on the board where the person attaches it in the browser (`web/src/pages/AttachmentUploadPage.tsx`).
- **Stated limit: a call ends at 55 s** (`toolDeadlineMs`, `server/src/mcp/routes.ts`), under Claude Code's 60 s; progress
  extends nothing, and VS Code sends no progress token. A `2024-11-05` HTTP+SSE client is refused
  (`server/test/mcp.transport.test.ts`).

## Invariants

- **Tools never hold a network credential.** The bridge forwards no client header but `Idempotency-Key`; the caller travels on the request class, so only `user` routes and the two open identity routes in `BRIDGE_OPEN_ROUTES` answer it.
- **Every call is scoped twice.** The tool layer refuses a caller without the tool's scope, and the route's own class check runs again inside the inject.
- **An unconfirmed answer is `inconclusive`.** A 5xx, timeout, abort, redirect, empty, null or schema-failing body is neither success nor failure; only a 4xx the board explained is a refusal, carrying the board's code verbatim.
- **One deadline per tool call** (`toolDeadlineMs`, 55 s, under Claude Code's 60 s) covers every inject; a client disconnect aborts them.
- **Stateless.** A server and its tools are built per request; a lost replica is a transport error, not lost state. `tools/list` is static and carries no organization data.
- **Registration limits are per replica.** DCR's rate limit and the CIMD fetch caps (concurrency, per-host bucket) count in one process, so N replicas admit N times the rate; the unauthenticated surface is bounded, not centrally metered. `server/src/oauth/rate-limit.ts`, `server/src/oauth/cimd-fetch.ts`.
- A caller runs at most `MAX_CONCURRENT_CALLS_PER_CALLER` calls at once per replica; metric labels are tool name and outcome only.
- **An organization holds at most `MCP_STREAMS_PER_ORG` requests open per replica**, counted under the org the gate resolved; one more is `429` with `Retry-After`. Each request also counts once against the request rate; the routes it bridges to do not. `server/test/mcp.stream-cap.test.ts`, `server/test/request-limits.test.ts`.
