# MCP server

The board's MCP endpoint (`POST /api/mcp`): a stateless Streamable HTTP server whose tools call the board's own routes in-process as the connected person.

| Concern | Code | Test |
| --- | --- | --- |
| Transport, hijack and stream, abort wiring, body limit, 2024-11-05 refusal | `server/src/mcp/routes.ts`, `server/src/mcp/pipe.ts` | `server/test/mcp.transport.test.ts` |
| Origin/Host policy, the auth gate (`enforceMcp`), `MCP_ENABLED` | `server/src/mcp/origin.ts`, `server/src/auth/plugin.ts`, `server/src/config-mcp.ts` | `server/test/mcp.transport.test.ts`, `server/test/config.mcp.test.ts` |
| The in-process caller: `app.inject` with the caller on the request class, one deadline, an abort signal | `server/src/mcp/bridge.ts`, `server/src/auth/bridge-binding.ts` | `server/test/mcp.bridge.test.ts` |
| Result mapping: 2xx data, board refusal with its own code, everything else `inconclusive` | `server/src/mcp/result.ts` | `server/test/mcp.result-mapping.test.ts` |
| Tool declaration (`defineTool`), annotation presets, the `ToolContext` a tool body gets | `server/src/mcp/tool.ts` | `server/test/mcp.registry.test.ts` |
| The static tool list (the batch tools are omitted from `tools/list`, and so not callable, while `BATCHES_ENABLED` is off), scope check, `confirm`, per-caller cap, metrics, one server per request | `server/src/mcp/registry.ts`, `server/src/mcp/server.ts` | `server/test/mcp.registry.test.ts` |
| The authorization server a client discovers from the 401 challenge: metadata, authorize, consent, token, revoke, client registration (CIMD, DCR) ([auth.md](auth.md)) | `server/src/routes/oauth.ts`, `server/src/routes/oauth-http.ts`, `server/src/routes/oauth-register.ts` | `server/test-db/oauth.sdk-flow.test.ts`, `server/test-db/oauth.client-registration.test.ts` |
| The consent screen (`/oauth/consent`) and the connected-apps panel on the Account page ([design-system/entry.md](design-system/entry.md)) | `web/src/pages/OAuthConsentPage.tsx`, `web/src/panels/ConnectedAppsPanel.tsx`, `server/src/routes/oauth-grants.ts` | `web/test/OAuthConsent.dom.test.tsx`, `web/test/ConnectedAppsPanel.dom.test.tsx`, `e2e/oauth-consent.spec.ts`, `server/test-db/routes.oauth-grants.test.ts` |
| Tools, one file per group | `server/src/mcp/tools/*.ts` | `server/test/mcp.whoami.test.ts`, `server/test-db/mcp.whoami.test.ts` |
| Discovery tools (`list_repos`, `list_executors`, `list_skills` (entries carry `source`; optional `repo`/`branch` adds that repository's skills), `list_connections`, `list_available_integrations`, `preflight_task`; `factory:read`): a repo list with a refresh error is `stale`, a composite read that half-fails is `inconclusive`, `preflight_task` keeps `blocked`, `unverified` and `integration_required` apart | `server/src/mcp/tools/discovery.ts`, `server/src/mcp/tools/skills.ts`, `server/src/mcp/tools/connections.ts`, `server/src/mcp/tools/preflight.ts` | `server/test/mcp.tools-discovery.test.ts` |
| Task, job, log and question tools (`list_tasks`, `list_jobs`, `investigate_job`, `job_activity`, `list_job_streams`, `read_job_log`, `list_questions`; `factory:read`): one shared run `state`, never `unreachable`/`inconclusive`; a half-failed composite read is `inconclusive`; the `read_job_log` cursor names the chunk it cut, and a vanished chunk is `inconclusive`, never a skip | `server/src/mcp/tools/{run-state,tasks,runs,logs}.ts` | `server/test/mcp.tools-jobs.test.ts`, `server/test-db/mcp.tools-jobs.test.ts` |
| Task detail and result tools (`get_task`, `get_task_result`; `factory:read`): one `GET /api/jobs/:id/thread` read, judged on the head run, no log reading; an unknown board status is `inconclusive`, a gate not known to have passed is never a pass, an unreadable thread is an `inconclusive` call, never `failed`; attachments are metadata only | `server/src/mcp/tools/task-detail.ts` | `server/test/mcp.tools-jobs.test.ts`, `server/test-db/mcp.tools-jobs.test.ts` |
| `wait_task` (`factory:read`): a bounded wait, default 45 s, at most 55 s, 3 s headroom; long-polls `GET /api/jobs/:id?waitFor=terminal&timeout=t` with a whole `t` of 1..60 and starts no hold the budget cannot cover; the verdict is the head re-read from the thread after the wait, mapped as `bellows job wait` maps it, a board `parked` poll being `needs_attention` whatever the head reads (an open question or requirement rides beside the result as `attention`); `pending`/never-claimed is `timeout`, an unconfirmed read is an `inconclusive` call, never `failed`; progress only when the request has a `progressToken`; the loop in `bounded-wait.ts` is generic over what settles | `server/src/mcp/bounded-wait.ts`, `server/src/mcp/tools/task-wait.ts` | `server/test/mcp.bounded-wait.test.ts`, `server/test/mcp.wait-task.test.ts` |
| Task write tools (`create_task`, `follow_up_task`, `retry_task`, `edit_task`, `answer_question`, `stop_task`, `mark_task_done`, `force_close_task`, `reopen_task`, `remove_task`; `factory:write`): each is one board route as the caller, board refusals verbatim; `stop_task`, `force_close_task` and `remove_task` need `confirm: true`, checked in the tool layer before any inject (the board route knows nothing of it); keyed writes pass `Idempotency-Key` through; `answer_question` also reads the thread (needs `factory:read` too) | `server/src/mcp/tools/task-writes.ts` | `server/test/mcp.tools-write.test.ts`, `server/test-db/mcp.tools-write.test.ts` |
| Batch tools, plan and read (`import_batch`, `update_batch`, `start_batch`: `factory:write`; `validate_batch`, `inspect_batch`, `list_batches`, `batch_report`: `factory:read`; [batches.md](batches.md)): each is one `/api/batches` route as the caller, board refusals verbatim (`BATCH_STALE` writes nothing, `BATCH_UNSUPPORTED` leaves a draft a draft, a refused plan lists its issues by path); the plan input advertises core's `BATCH_PLAN_JSON_SCHEMA`; `standing` is the board's and is never computed here; `batch_report` reads the batch beside the report and a report that misses a task is `inconclusive`, a board-stale observation sets `stale` | `server/src/mcp/tools/batches.ts`, `server/src/mcp/result.ts` | `server/test/mcp.tools-batch.test.ts`, `server/test-db/mcp.tools-batch.test.ts`, `server/test/mcp.result-mapping.test.ts` |
| Batch tools, wait and control (`wait_batch`, `get_batch_tasks`: `factory:read`; `retry_batch_task`, `accept_batch_task`, `cancel_batch`: `factory:write`, `cancel_batch` destructive and refused without `confirm: true`): `wait_batch` is `wait_task`'s bounded loop over `GET /api/batches/:id?waitFor=terminal`, and its verdict, `attention[]` and `verificationFailures[]` come from a re-read of the board's `standing` (a fence is `cancelled`, an `inconclusive` standing is an inconclusive call, never a verdict; a board that answers settled over a running standing is re-read every 5 s to `timeout`, like the CLI), mapped like `bellows batch wait` (0/4/5/6, timeout 3); `get_batch_tasks` pages the record, plan and report of one `GET /api/batches/:id` read in plan order behind a `(batch, filters, version, stage, key)` cursor (`bad_cursor`, `stale_cursor`), no board route added, a report that misses a task is `inconclusive` | `server/src/mcp/tools/batch-wait.ts`, `server/src/mcp/tools/batch-tasks.ts`, `server/src/mcp/tools/batches.ts` | `server/test/mcp.wait-batch.test.ts`, `server/test/mcp.tools-batch.test.ts`, `server/test-db/mcp.tools-batch.test.ts` |
| Attachment handoff (`create_attachment_upload`, `factory:write`; the registry is 40 tools): no file bytes, local path or URL ever passes through MCP. Without `uploadId` it mints a single-use, 15-minute upload link bound to the caller, org, OAuth grant family, size and media types (`uploadUrl` for one HTTP PUT of the raw file, `pageUrl` for the browser page); with `uploadId` it reads the state (`open`, `completed` with `attachmentId`, `expired`, `removed`), and an unreadable state is `inconclusive`, never "missing". A retry of the same bytes returns the same file, other bytes are `UPLOAD_CAPABILITY_SPENT`; the ids bind through `create_task` / `follow_up_task` like any upload. Clients: Claude Code and any client with a shell PUT to `uploadUrl`; a client without a shell (claude.ai, Claude Desktop) opens `pageUrl`; a client with neither cannot attach files | `server/src/mcp/tools/attachments.ts`, `server/src/routes/attachment-uploads.ts`, `server/src/routes/attachment-ingest.ts`, `server/src/attachments/upload-capability-store.ts`, `server/migrations/124_attachment_upload.sql`, `web/src/pages/AttachmentUploadPage.tsx` | `server/test/mcp.attachment-upload.test.ts`, `server/test-db/mcp.attachment-handoff.test.ts`, `server/test-db/attachment-store.test.ts`, `web/test/AttachmentUploadPage.dom.test.tsx`, `e2e/attachment-upload.spec.ts` |
| Which routes a scoped caller may reach, and which open routes a bridged call may | `server/src/auth/route-class.ts` | `server/test/auth.enforcement.test.ts`, `server/test/auth.me-bridged.test.ts` |
| End to end: a real SDK client through consent and a task to its end (e2e, docker lane, kind lane); the 40-tool registry snapshot; the chart's https-only gate and ingress routing | `e2e/mcp-connect.spec.ts`, `scripts/mcp-phase-client.mjs`, `scripts/mcp-kind-client.mjs`, `charts/factory/templates/validate.yaml`, `charts/factory/templates/ingress.yaml` | `e2e/mcp-connect.spec.ts`, `server/test/mcp.registry-snapshot.test.ts`, `scripts/test-jobs.sh` (`--phase mcp`), `scripts/test-k8s.sh` (`mcp` phase), [kubernetes.md](kubernetes.md) |
| `factory_mcp_tool_duration_seconds{tool,outcome}` | `server/src/metrics.ts` | `server/test/mcp.whoami.test.ts` |

## Adding a tool

Create `server/src/mcp/tools/<name>.ts` with `defineTool({ name, description, scope, routes, annotations, input, output, run })`
and add it to `TOOLS` in `registry.ts`. `run(args, ctx)` returns a `Tagged` result: `ctx.call(request, schema, summarize)`
for one board call, or `ctx.fetch` plus `judge`/`success` from `result.ts` when several are composed.
`routes` lists each backing route as registered; `mcp.registry.test.ts` fails when `scope` disagrees with a route's class
in `route-class.ts`, or when a route has none; `output` (a zod object) is required, advertised as `outputSchema`, and a success that fails it is `inconclusive`. A destructive tool takes `annotations: DESTRUCTIVE, confirm: true`.

## Connecting a client

The endpoint is `https://<board host>/api/mcp`; a client finds the authorization server from the 401 challenge and the
`/.well-known/oauth-*` documents, registers by CIMD or DCR, and the member approves on the consent screen.

```bash
claude mcp add --transport http factory https://<board host>/api/mcp   # then /mcp -> Authenticate (browser consent)
claude -p "call whoami on the factory server"                          # headless, once authenticated
```

The working references are `e2e/mcp-connect.spec.ts` and `scripts/mcp-phase-client.mjs`.

## Client support

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
