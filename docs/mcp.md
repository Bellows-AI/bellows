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
| Tools, one file each | `server/src/mcp/tools/*.ts` | `server/test/mcp.whoami.test.ts`, `server/test-db/mcp.whoami.test.ts` |
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
- A caller runs at most `MAX_CONCURRENT_CALLS_PER_CALLER` calls at once per replica; metric labels are tool name and outcome only.
