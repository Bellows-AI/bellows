# agent-telemetry

A Claude Code plugin that posts `session → (repo, branch)` to a Factory dashboard, so token usage
is attributed to the repo. In-container twin: `docker/claude-executor/branch-reporter.cjs`.

| Concern | Code |
| --- | --- |
| The report: payload, endpoint, credential, timeout, sampling | `scripts/session-telemetry.mjs` |
| Which events fire it (`SessionStart`, `PostToolUse` on `Bash`, `SessionEnd`) | `hooks/hooks.json` |
| The route it posts to (`/api/sessions/branch`) | `server/src/routes/ingest.ts` |

## Invariants

- OTLP metrics carry only `session.id`; this hook is the only repo link. Without it a session is
  counted in `sessionsWithoutHook`, not the totals — so `OTEL_METRICS_INCLUDE_SESSION_ID` must stay
  true (the default).
- **Install at user scope**, not in this repo: the sessions that matter happen in the repos you
  work in.
- Keep the `OTEL_LOG_*` content switches off — [docs/security.md](../../docs/security.md).
- `cwd` and `transcript_path` are read locally and never transmitted. No prompts, no file
  contents, no diff, no identity.
- Against `AUTH_MODE=github`, `FACTORY_STATS_TOKEN` must be a personal access token (`fat_…`); the
  organization comes from the credential, never from the repo the report names. Organization
  tokens (`oat_…`) are rejected.
- Store the token in `~/.claude/settings.json` only — a repo's `.claude/settings.json` is tracked.
  A credentialed report goes only to `https://` or an explicit loopback host; otherwise it is dropped.
- Every failure is a silent no-op, exit 0 (200ms timeout, fire-and-forget). No retry queue, no
  spool file, no dependencies beyond Node builtins and `git`.

## Limits

- The branch is **sampled** once per 20s per session plus session start and end, not tracked — a
  branch held for less than one interval can be missed. Coverage starts at install. Today only
  the repo half of the report is read.

## Commands

```bash
claude plugin marketplace add /path/to/factory-ai
claude plugin install agent-telemetry@factory-ai
claude plugin validate ./plugins/agent-telemetry   # malformed hooks.json = plugin loads, hooks don't
```

`FACTORY_STATS_URL` overrides the endpoint (default `http://127.0.0.1:8080`). Token counts come from
Claude Code's own OTLP export, configured separately — copy the `env` block of this repo's
`.claude/settings.json`.
