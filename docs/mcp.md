# MCP server

The board's MCP endpoint (`POST /api/mcp`): a stateless Streamable HTTP server whose tools call the board's own routes in-process as the connected person.

| Concern | Code | Test |
| --- | --- | --- |
| Transport, hijack and stream, abort wiring, body limit, 2024-11-05 refusal | `server/src/mcp/routes.ts`, `server/src/mcp/pipe.ts` | `server/test/mcp.transport.test.ts` |
| Origin/Host policy, the auth gate (`enforceMcp`), `MCP_ENABLED` | `server/src/mcp/origin.ts`, `server/src/auth/plugin.ts`, `server/src/config-mcp.ts` | `server/test/mcp.transport.test.ts`, `server/test/config.mcp.test.ts` |
| The in-process caller: `app.inject` with the caller on the request class, one deadline, an abort signal | `server/src/mcp/bridge.ts`, `server/src/auth/bridge-binding.ts` | `server/test/mcp.bridge.test.ts` |
| Result mapping: 2xx data, board refusal with its own code, everything else `inconclusive` | `server/src/mcp/result.ts` | `server/test/mcp.result-mapping.test.ts` |
| Tool declaration (`defineTool`), annotation presets, the `ToolContext` a tool body gets | `server/src/mcp/tool.ts` | `server/test/mcp.registry.test.ts` |
| The static tool list, scope check, `confirm`, per-caller cap, metrics, one server per request | `server/src/mcp/registry.ts`, `server/src/mcp/server.ts` | `server/test/mcp.registry.test.ts` |
| The authorization server a client discovers from the 401 challenge: metadata, authorize, consent, token, revoke, client registration (CIMD, DCR) ([auth.md](auth.md)) | `server/src/routes/oauth.ts`, `server/src/routes/oauth-http.ts`, `server/src/routes/oauth-register.ts` | `server/test-db/oauth.sdk-flow.test.ts`, `server/test-db/oauth.client-registration.test.ts` |
| The consent screen (`/oauth/consent`) and the connected-apps panel on the Account page ([design-system/entry.md](design-system/entry.md)) | `web/src/pages/OAuthConsentPage.tsx`, `web/src/panels/ConnectedAppsPanel.tsx`, `server/src/routes/oauth-grants.ts` | `web/test/OAuthConsent.dom.test.tsx`, `web/test/ConnectedAppsPanel.dom.test.tsx`, `e2e/oauth-consent.spec.ts`, `server/test-db/routes.oauth-grants.test.ts` |
| Tools, one file per group | `server/src/mcp/tools/*.ts` | `server/test/mcp.whoami.test.ts`, `server/test-db/mcp.whoami.test.ts` |
| Discovery tools (`list_repos`, `list_executors`, `list_skills`, `list_connections`, `list_available_integrations`, `preflight_task`; `factory:read`): a repo list with a refresh error is `stale`, a composite read that half-fails is `inconclusive`, `preflight_task` keeps `blocked`, `unverified` and `integration_required` apart | `server/src/mcp/tools/discovery.ts`, `server/src/mcp/tools/skills.ts`, `server/src/mcp/tools/connections.ts`, `server/src/mcp/tools/preflight.ts` | `server/test/mcp.tools-discovery.test.ts` |
| Task, job, log and question tools (`list_tasks`, `list_jobs`, `investigate_job`, `job_activity`, `list_job_streams`, `read_job_log`, `list_questions`; `factory:read`): every run reads in the shared `state` vocabulary (`pending`, `running`, `succeeded`, `failed`, `cancelled`, `needs_attention`; an open question or integration requirement is `needs_attention`; `unreachable` and `inconclusive` are never mapped, only said), a composite read that half-fails is `inconclusive`, `read_job_log` pages by bytes (default 32 KiB, cap 256 KiB) with its own cursor that continues inside a cut chunk and says `complete` only for finalized streams, the log text is the board's stored, already masked text | `server/src/mcp/tools/{run-state,tasks,runs,logs}.ts` | `server/test/mcp.tools-jobs.test.ts`, `server/test-db/mcp.tools-jobs.test.ts` |
| Which routes a scoped caller may reach, and which open routes a bridged call may | `server/src/auth/route-class.ts` | `server/test/auth.enforcement.test.ts`, `server/test/auth.me-bridged.test.ts` |
| `factory_mcp_tool_duration_seconds{tool,outcome}` | `server/src/metrics.ts` | `server/test/mcp.whoami.test.ts` |

## Adding a tool

Create `server/src/mcp/tools/<name>.ts` with `defineTool({ name, description, scope, routes, annotations, input, output, run })`
and add it to `TOOLS` in `registry.ts`. `run(args, ctx)` returns a `Tagged` result: `ctx.call(request, schema, summarize)`
for one board call, or `ctx.fetch` plus `judge`/`success` from `result.ts` when several are composed.
`routes` lists each backing route as registered; `mcp.registry.test.ts` fails when `scope` disagrees with a route's class
in `route-class.ts`, or when a route has none; `output` (a zod object) is required, advertised as `outputSchema`, and a success that fails it is `inconclusive`. A destructive tool takes `annotations: DESTRUCTIVE, confirm: true`.

## Invariants

- **Tools never hold a network credential.** The bridge forwards no client header but `Idempotency-Key`; the caller travels on the request class, so only `user` routes and the two open identity routes in `BRIDGE_OPEN_ROUTES` answer it.
- **Every call is scoped twice.** The tool layer refuses a caller without the tool's scope, and the route's own class check runs again inside the inject.
- **An unconfirmed answer is `inconclusive`.** A 5xx, timeout, abort, redirect, empty, null or schema-failing body is neither success nor failure; only a 4xx the board explained is a refusal, carrying the board's code verbatim.
- **One deadline per tool call** (`toolDeadlineMs`, 55 s, under Claude Code's 60 s) covers every inject; a client disconnect aborts them.
- **Stateless.** A server and its tools are built per request; a lost replica is a transport error, not lost state. `tools/list` is static and carries no organization data.
- **Registration limits are per replica.** DCR's rate limit and the CIMD fetch caps (concurrency, per-host bucket) count in one process, so N replicas admit N times the rate; the unauthenticated surface is bounded, not centrally metered. `server/src/oauth/rate-limit.ts`, `server/src/oauth/cimd-fetch.ts`.
- A caller runs at most `MAX_CONCURRENT_CALLS_PER_CALLER` calls at once per replica; metric labels are tool name and outcome only.
