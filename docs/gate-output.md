# Gate output

What a gate run keeps of its output: the whole log as a stream of the run, and a failure-first excerpt in the stored report, so neither the agent nor a person loses which tests failed to a tail full of stacks.

| Concern | Code | Test |
| --- | --- | --- |
| The run's answer: output tail-kept at `ARTIFACT_LIMIT` (`fullOutput`, `fullTruncated`), the answer's `output` its failure excerpt at the 16 KiB report limit | `driver/src/gate-manager.ts` (`gateRunOf`), `driver/src/runner.ts` | `driver/test/gate-output.test.ts` |
| The excerpt: `FAIL` / `×` lines, then the `Test Files` / `Tests` summary, then the tail; a log with none is its plain tail | `driver/src/gate-excerpt.ts` | `driver/test/gate-excerpt.test.ts` |
| The stored per-gate `output`: a passed gate keeps a short tail, the failed ones share the rest of the report budget | `driver/src/loop/loop-gates.ts` (`outputBudgets`, `settledGate`) | `driver/test/loop/gate-logs.test.ts`, `driver/test/loop/setup-and-gates.test.ts` |
| The log stream `gate-<name>-<execution id>`: uploaded when a recorded run ends, declared pass and ad-hoc call alike, on both executors, bounded to a short retry | `driver/src/gate-record.ts` (`finish`), `driver/src/artifact-upload.ts` (`gateStreamName`, `uploadGateLog`), `driver/src/loop/loop-gates.ts` (`gateLedger`) | `driver/test/loop/gate-logs.test.ts` |
| `factory-gate <name> --last --full`: the report's run id (`executionId` of `lastGateReports`) read back through the board | `driver/src/gates.ts` (`lastReportAnswer`), `driver/src/gate-request.ts`, `docker/executor-common/factory-gate.cjs`, `driver/src/board/board-gate-runs.ts` (`gateLog`) | `driver/test/gates.test.ts`, `driver/test/factory-wrappers.test.ts`, `driver/test/board-gate-runs.test.ts` |
| The board read: `POST /api/jobs/:id/gate-log`, a lease route finding the stream by execution id across the thread's rows | `server/src/routes/jobs/job-handlers-gate-log.ts`, `server/src/db/jobs/job-store-gate-reports.ts` | `server/test/routes.gate-log.test.ts`, `server/test/auth.enforcement.test.ts` |
| What users read | `site/guides/gates.mdx`, `site/cli/commands.mdx`, `docker/skills/factory-gates/SKILL.md` | `server/test/site-docs.test.ts` |

## Invariants

- The excerpt is taken from the uncut output, before the log's `ARTIFACT_LIMIT` cap; the stored log is a tail and may no longer hold the failing names.
- A stream no manifest closed answers a retryable 503 (never 404, never a prefix as whole); one finalized short of `complete` answers its bytes with `truncated` and the manifest's `cause`.
- The log never rides the gates report: the report keeps its 16 KiB raw budget (the 128 KiB body bound), and the log goes by chunked artifact upload under the claim.
- A log that could not be stored costs the full read, never a verdict; `--last --full` answers 404 for a log the board lacks and a retryable 503 for one it could not read, never the excerpt in its place.
- Both executors run the same driver path: a gate is a supervised step in the task group, so there is no kubernetes-only counterpart and no limit to state.
- Gate streams sit under the thread's artifact prefix, so [retention](retention.md) expires them with the thread.
