/** The CLI's whole help text: `bellows help` prints it, and every usage error ends with it. */
export const USAGE = `usage: bellows job create (<command...> | --file <path> | --stdin) [--repo owner/name] [--executor name] [--executor-scope user|org]
                          [--skill name]... [--jira-connection <id>] [--idempotency-key <key>] [--json]
       bellows job list [--status <status>] [--limit <n>] [--repo owner/name] [--json]
       bellows task list [--state attention|running|review|past] [--q <text>] [--author <login>] [--repo owner/name]
                         [--sort newest|oldest] [--limit <n>] [--cursor <cursor>] [--json]
       bellows job investigate <id> [--json]
       bellows job log|transcript <id> [--attempt <n>] [--offset <n>] [--limit <n>] [--all] [--json]
       bellows job activity <id> [--json]
       bellows job wait <id> [--timeout <seconds>] [--json]
       bellows job follow-up <id> (<command...> | --file <path> | --stdin) [--idempotency-key <key>] [--json]
       bellows job retry <id> [--idempotency-key <key>] [--json]
       bellows job edit <id> (<command...> | --file <path> | --stdin) [--json]
       bellows job questions <id> [--json]
       bellows job answer <id> <question-id> --answer <text>... [--json]
       bellows job stop <id> [--json]
       bellows job done <id> [--force] [--json]
       bellows job reopen <id> [--json]
       bellows job remove <id> --yes [--json]
       bellows repo list [--json]          repositories visible to the board, and which are synced
       bellows executor list [--json]      executor profiles by scope (--executor-scope)
       bellows skill list [--json]         skills a task may select (--skill)
       bellows connection list [--json]    managed connections you may select (--jira-connection)
       bellows job preflight [--repo owner/name] [--executor name] [--executor-scope user|org]
                             [--skill name]... [--jira-connection <id>] [--json]
       bellows batch import (--file <path> | --stdin) [--idempotency-key <key>] [--json]
       bellows batch update <id> --version <n> (--file <path> | --stdin) [--json]
       bellows batch validate <id> [--json]
       bellows batch start <id> --version <n> [--idempotency-key <key>] [--json]
       bellows batch inspect <id> [--json]
       bellows batch report <id> [--json]
       bellows batch list [--json]
       bellows batch wait <id> [--timeout <seconds>] [--json]
       bellows batch retry <id> <task> [--json]
       bellows batch accept <id> <task> [--json]
       bellows batch cancel <id> [--json]
       bellows auth status [--json]      the configuration and each value's source, the board's version,
                                         and who the token acts as
       bellows help | --help | -h          this text; bellows --version prints the CLI's version
                                           (neither reads any configuration)

preflight checks a create's selection against the board's reads and only reads. It is advisory:
the board rechecks at create and at claim, and its refusal is the answer.

unattended use (cron, CI): mint a personal token (fat_...) from the board's settings page and hand
it to the job as FACTORY_TOKEN from the scheduler's secret store — never as an argument, never
committed. It acts as you until revoked or your membership ends; \`bellows auth status\` checks it
and only reads. An org token (oat_...) only reads and cannot queue a task.

'task list' is one row per task plus its head run; 'job list' is per run. A --cursor fits only its own filters.
batch plans are JSON documents (the board's plan contract, docs/batches.md): import makes a draft,
update replaces the whole draft at the --version you last read (a stale one is refused and nothing
is written), validate shows the plan as start would freeze it — each stage's effective policy and
the concurrency — and start freezes it at that version. The plan is carried whole: a
multi-repository draft round-trips through inspect and update, but start refuses it for now (one
repository target on its default branch). The board runs the batch: wait only watches — it ends
0 when every task succeeded, 4 when one failed, 5 when cancelled or expired, 6 when a task waits on a person
(a human review gate; the PRs needing action are listed) and 3 when the budget ran out — and
leaving it, or the CLI, never cancels anything. A code-changing task needs its merged PR;
accept only answers a declared human-reviewed no-PR task, and the board refuses the rest.

config:
  FACTORY_URL    the board's base URL (required)
  FACTORY_TOKEN  a personal access token (fat_...) minted from the settings page;
                 omit it against an open (AUTH_MODE=none) board
  FACTORY_REQUEST_TIMEOUT_S  one request's deadline, headers and body included (default 30)
  FACTORY_READ_RETRIES       re-issues of a failed read or keyed write, never an unkeyed write (default 3; 0 = off)
  ~/.bellows/settings.json   the same four as JSON keys url, token, requestTimeoutS, readRetries;
                             a set variable wins over its key. A file holding a token must be mode 600.
  --config <path>            on any command: read that settings file instead (it must exist)

exit codes: 0 ok (a wait: the run succeeded), 1 the board refused, 2 usage or configuration,
            3 a wait ran out of budget, 4 the run failed or died, 5 the run was stopped on the
            board, 6 the thread is parked on a workflow wait, 7 the board was unreachable,
            130 interrupted locally

--json prints one envelope on stdout and nothing on stderr, whatever the outcome:
  { ok, command, outcome, exitCode, data, error }

log and transcript read the STORED artifact (not investigate's tail), newest attempt unless --attempt
names one: one page from --offset per call (stderr names the next), or with --all every page, failing
naming the page that could not be read rather than printing a partial artifact. --all takes no --offset.

retry queues a fresh attempt of the task's existing command; follow-up queues NEW instructions.
edit replaces the command of a queued run you created, in place; the board refuses it once the run
is claimed. reopen undoes done. The board decides every refusal.

done on a live batch's thread is refused: the batch closes it when it ends. --force closes it now:
the board stops the run, cancels its batch task (never retried; a required one holds its stage until
the batch is cancelled) and leaves its PR open.

A question's --answer values go one per prompt, in the order \`job questions\` lists them: an
option's label, or free text (a multi-select joins its picks with ", "). The board is the
arbiter: an answer that lost to an earlier one, arrived after the question expired, or whose run
is no longer waiting is refused (exit 1) and never retried.

--file reads the command from a file and --stdin from standard input, exactly as written
(newlines and Unicode kept); give one source, never two. An empty or over-long command is
refused here, before any request.

'--' ends option parsing, so a create command that takes flags of its own can follow it:
  bellows job create --repo owner/name -- npm test --watch

retry re-runs the finished task's own command as a fresh attempt in the same thread; a follow-up
is the command for NEW instructions.

--idempotency-key names one logical write (8-128 of letters, digits . _ : -). Repeat the SAME
command with the SAME key to recover a write whose answer never arrived: the board returns the
task the first attempt made instead of a second one, and a different request under the key is
refused. A genuinely new task or retry takes a new key. A key is remembered for 24 hours.`;
