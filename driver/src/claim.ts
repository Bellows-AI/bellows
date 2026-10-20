/**
 * What a claim resolves to inside any runner, whichever executor starts it: the workspace and
 * working-directory paths, the transcript and opencode-database locations, the gate identity, and
 * the claim env (with the driver's reserved names) the runner receives. The docker runner renders
 * these into `docker run` flags, the kubernetes runner into a Job spec — the values must match.
 */

import type { DriverConfig } from './config.js';
import type { BoardJob } from './board.js';
import { OPENCODE } from './executors.js';
import { opencodeConfigContent } from './master-prompt.js';
import { UUID, WORKSPACE_PATH, worktreeDir } from './publish.js';
import { SUPERVISOR_ENV } from './supervisor-contract.js';

export { UUID };

/**
 * What an agent session id may look like before it is interpolated into runner argv — claude's
 * uuids and opencode's `ses_…` both qualify, and nothing shell-shaped does. The id on a resume
 * claim comes from the board, and a board is not something this process trusts with a fragment of
 * a command. Copied from server/src/routes/jobs.ts, which states the same rule for the report:
 * this package depends on nothing, deliberately. Exported because the kubernetes runner asserts
 * the same id before the same interpolation.
 */
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

/**
 * The uid:gid the gate environment runs as, and the HOME it gets: the executor images' `USER
 * node` (uid 1000 in both Dockerfiles), which the runner, the sync and the reclaim containers all
 * run as. Gates write the shared task worktree, and every other writer on that tree is uid 1000 —
 * a gate writing as the declared image's own default (root, usually) would leave files the
 * uid-1000 reclaim can never remove. Exported because the kubernetes gate Job states the same
 * numbers as a securityContext (executor parity).
 */
export const GATE_UID = 1000;
export const GATE_GID = 1000;
/**
 * The uid the agent's tool commands run as (issue #814): `factory-tool` in both executor images, in
 * group GATE_GID beside the CLI's uid, so a tool cannot signal the CLI that started it. The terminal
 * reclaim's release pass runs as it too, to give back what a tool closed to the uid-1000 reclaim.
 */
export const TOOL_UID = 1001;
/**
 * The uid the task pod's reviewer container runs as (issue #774), in group GATE_GID: distinct from the
 * CLI's, the tool's and the gate's, so no one of them can signal a review mid-run. Its HOME is the
 * one directory of the task volume it may write (`REVIEWER_TREE_DIR`), group-writable so the
 * supervisor's uid reads and removes what a review left; the rest of the tree it mounts read-only.
 */
export const REVIEWER_UID = 1002;
export const REVIEWER_HOME = '/home/reviewer';
/** The member-tree directory the reviewer's HOME is mounted from: a fixed subPath, never one per review. */
export const REVIEWER_TREE_DIR = '.factory/reviewer';
/** Where the reviewer's home keeps its session state: the transcript store (per thread root) and opencode's data directory. */
export const REVIEWER_TRANSCRIPTS = 'transcripts';
export const REVIEWER_DATA = 'data';
/** That directory as the supervisor and the other containers of the pod see it. */
export const reviewerTreeDir = (config: Pick<DriverConfig, 'workspaceMount'>, job: BoardJob): string =>
    `${config.workspaceMount}/${workspacePath(job)}/${REVIEWER_TREE_DIR}`;
/** A review's transcript store, in the reviewer's home, named by the thread root. */
export const reviewerTranscriptName = (review: Pick<BoardJob, 'id' | 'rootJobId'>): string =>
    `${REVIEWER_TRANSCRIPTS}/${review.rootJobId ?? review.id}`;
/**
 * The capabilities the agent container starts with (issue #814), as root, every other one dropped:
 * what the tool broker needs to start each command as TOOL_UID. factory-launch drops both, and root,
 * before the CLI runs; no other container the driver starts gets either.
 */
export const AGENT_LAUNCH_CAPS = ['SETUID', 'SETGID'] as const;
const NPM_UPDATE_NOTIFIER = 'NPM_CONFIG_UPDATE_NOTIFIER';
/**
 * Runner and gate env, both executors: npm's update notice is the last line every npm call prints,
 * and it buries the summary a job's output tail exists to show (#511). A default only — a claim
 * that names it wins, so the driver never states the name beside it (docker's `-e` would beat the
 * env file, a pod's `env` would beat `envFrom`, and a runner pod would carry the name twice).
 */
export function npmQuietEnv(job: Pick<BoardJob, 'env'> | undefined): [string, string][] {
    return Object.hasOwn(job?.env ?? {}, NPM_UPDATE_NOTIFIER) ? [] : [[NPM_UPDATE_NOTIFIER, 'false']];
}
/**
 * The data directory (XDG_DATA_HOME) an opencode run gets: one directory per TASK — the thread
 * root, like the claude transcript store — inside the member's tree on the workspaces volume, so
 * every attempt and follow-up of a task resumes in one session database and two tasks of one
 * member never share a file. The opencode entrypoint derives the member tree from this shape. The
 * root is asserted before it joins the path, as in `transcriptDir`.
 */
export function opencodeDataDir(config: DriverConfig, job: BoardJob): string {
    const path = workspacePath(job);
    const root = job.rootJobId ?? job.id;
    if (!UUID.test(root)) {
        throw new Error(`refusing to run job ${job.id}: a thread root id that is not a uuid: ${root}`);
    }
    return `${config.workspaceMount}/${path}/.factory/opencode/${root}`;
}

/** The session database opencode writes under the task's data directory. */
export function opencodeDbPath(config: DriverConfig, job: BoardJob): string {
    return `${opencodeDataDir(config, job)}/opencode/opencode.db`;
}

/**
 * The working directory the runner gives a run: the task worktree when the job names a repository,
 * the member root where a command-only job always started. This is the exact string opencode
 * records as the session's `directory` column, which makes it the close-time readout's scope key
 * too — one expression here because the run's WORKDIR and the readout's OPENCODE_DIR must never
 * drift apart: a scope key that misses is a scrape that answers nothing.
 */
export function runWorkingDir(config: DriverConfig, job: BoardJob): string {
    return worktreeDir(config, job) ?? `${config.workspaceMount}/${workspacePath(job)}`;
}

/**
 * The transcript store a headless claude-code run is pointed at: one directory per THREAD ROOT on
 * the workspaces volume, passed to the runner as `FACTORY_TRANSCRIPT_DIR`. The entrypoint makes it
 * `CLAUDE_CONFIG_DIR` (guarded, headless only), so the CLI writes its transcripts onto the volume
 * the moment it writes them — no post-run copy, nothing dies with the container — and a follow-up's
 * `--resume` finds the thread's earlier sessions in the same directory it runs in. The root is the
 * claim's worktree key (`rootJobId ?? id`), which is what makes every attempt and follow-up of one
 * thread land in one directory.
 *
 * Both board-supplied halves are asserted before they join the path, exactly like `runWorkingDir`:
 * the value becomes a filesystem path inside a container that runs the agent, and neither the
 * workspace path nor the root id (which a board predating the field omits, making the job its own
 * root) is something this process trusts unasserted.
 */
export function transcriptDir(config: DriverConfig, job: BoardJob): string {
    const path = workspacePath(job);
    const root = job.rootJobId ?? job.id;
    if (!UUID.test(root)) {
        throw new Error(`refusing to run job ${job.id}: a thread root id that is not a uuid: ${root}`);
    }
    return `${config.workspaceMount}/${path}/.factory/transcripts/${root}`;
}

/**
 * The full `docker run` argument list. Pure, and exported, because it is the part worth pinning in
 * a test: everything security-relevant about a runner is decided here.
 *
 * The session id is minted by the caller, not read back out of the container. An interactive Remote
 * Control session reports its state into a TUI rather than onto stdout, so there is nothing
 * parseable to scrape — and a runner that dies early would leave the job with no session at all.
 */
/**
 * The job's workspace, or a refusal. Exported so `loop.ts` can fail a job cleanly rather than
 * letting `dockerArgs` throw halfway through building a command.
 */
export function workspacePathOf(job: Pick<BoardJob, 'workspacePath'>): string | null {
    return job.workspacePath && WORKSPACE_PATH.test(job.workspacePath) ? job.workspacePath : null;
}

export function workspacePath(job: Pick<BoardJob, 'id' | 'workspacePath'>): string {
    const path = workspacePathOf(job);
    if (!path) {
        throw new Error(
            `refusing to run job ${job.id}: the board reported no usable workspace path (${job.workspacePath ?? 'null'})`
        );
    }
    return path;
}

/**
 * The agent container's memory-backed GitHub token cache (docs/connections.md): the executor
 * images' helper writes only here (`CACHE_DIR` in each image's github-credential.cjs), and both
 * executors mount it in the agent container alone — docker a `--tmpfs`, kubernetes an
 * `emptyDir: {medium: Memory}` — so the helper's cached token never reaches a disk or the task volume.
 */
export const GITHUB_CACHE_DIR = '/run/factory-github';
/** The cache's ceiling, one small JSON file: the kubernetes quantity and the docker tmpfs size. */
export const GITHUB_CACHE_SIZE = { k8s: '1Mi', docker: '1m' } as const;

/** The env names the loop mints for a launched attempt's run-control channel (issue #442). */
export const CONTROL_URL_ENV = 'BELLOWS_CONTROL_URL';
export const CONTROL_TOKEN_ENV = 'BELLOWS_CONTROL_TOKEN';
/**
 * Set to `1` by the runner plan for a takeover or handover (issue #822): the session it resumes may
 * never have been written, and the runner may start it anew. Never for a follow-up.
 */
export const RESUME_MAY_BE_UNWRITTEN_ENV = 'BELLOWS_RESUME_MAY_BE_UNWRITTEN';

/**
 * The names the runner's own contract claims — WORKDIR is the working directory dockerArgs itself
 * sets, the two BELLOWS_GATE_ names are the
 * ad-hoc gate credentials the loop mints per attempt, CRED_HELPER is the credential-helper CODE
 * the sync fetch runs, RESTORE is the sync's restore-mode switch (a member value there would
 * flip starting claims into restore mode, silently skipping the fetch and rebase issue #58
 * reserves for continuations), the two SYNC_LOCK_* names are the startup sync lock's bounds
 * (issue #307 — a member value would shrink the wait to nothing or make every sync steal its
 * neighbour's live lock), FACTORY_TRANSCRIPT_DIR is where the headless transcript store
 * lives — the driver composes it (transcriptDir), and a member value would steer transcripts,
 * and through the entrypoint's redirect the CLI's whole config dir, somewhere else — and the
 * three reporter names steer the branch reporter — where it posts, which attempt it speaks for,
 * and which session it claims. A member value in any of them is a cross-tenant write into the
 * telemetry store; CRED_HELPER above all: a member value there is member-controlled code the
 * sync container's git executes as helper code. Mirrored at the board (RESERVED_ENV_NAMES in
 * server/src/routes/env.ts, where a PUT is refused); copied rather than imported, per this
 * package's zero-dependency rule. The board's list is a superset by two names:
 * OPENCODE_CONFIG_CONTENT and CLAUDE_CODE_CONFIG_CONTENT are reserved THERE — the claim
 * synthesizes each from the author's executor row, and a member env var would be silently
 * shadowed — but deliberately absent here, because `claimEnv` must let that synthesized value
 * flow to reach the runner.
 */
export const RESERVED_ENV_NAMES = [
    'WORKDIR',
    'BELLOWS_GATE_URL',
    'BELLOWS_GATE_TOKEN',
    // The run-control channel the loop mints per launched attempt (issue #442): the agent's own
    // publish/review pair, the task supervisor's pair and the exporter's token — a member value under
    // those names would reach the agent by the same Secret key the minted credential lives under.
    CONTROL_URL_ENV,
    CONTROL_TOKEN_ENV,
    SUPERVISOR_ENV.controlUrl,
    SUPERVISOR_ENV.controlToken,
    SUPERVISOR_ENV.exportToken,
    'CRED_HELPER',
    'RESTORE',
    'REVIEW_REF',
    'BASE_BRANCH',
    'SYNC_LOCK_WAIT_MS',
    'SYNC_LOCK_STALE_MS',
    'FACTORY_TRANSCRIPT_DIR',
    // The board-rendered turn context the claude runner's UserPromptSubmit hook reads (issue #509).
    'FACTORY_TURN_CONTEXT',
    'FACTORY_STATS_URL',
    'RUNNER_JOB_ID',
    'RUNNER_LEASE_TOKEN',
    'BELLOWS_SESSION_ID',
    // The driver's grant alone: a member value would let a follow-up start its parent's lost
    // conversation empty instead of failing.
    RESUME_MAY_BE_UNWRITTEN_ENV,
    // Jira credentials are a managed connection now (docs/connections.md), never claim env.
    'ATLASSIAN_SITE',
    'ATLASSIAN_EMAIL',
    'ATLASSIAN_API_TOKEN',
    // GitHub is the App's: the runner's helper and the supervised steps obtain a token from the
    // board (docs/connections.md), so no claim value may stand in for it.
    'GITHUB_TOKEN',
    'GH_TOKEN',
    // The agent container starts as root to launch its tool broker (issue #814): the glibc loader
    // reads these for that root shell before any line of it runs. Every `LD_` name too (claimEnv).
    'GCONV_PATH',
    'GLIBC_TUNABLES',
    'LOCPATH',
    'NLSPATH',
    'MALLOC_TRACE',
] as const;

/** Every loader name, listed or not; mirrored at the board (isReservedEnvName in core/src/env.ts). */
const LOADER_ENV_PREFIX = 'LD_';

/** The job fields the repo cache path is composed from. */
export type CacheJob = Pick<BoardJob, 'id' | 'env' | 'repo' | 'gates' | 'workspacePath'>;

/**
 * Names a cache path may not take: the driver's own and the ones a shell, loader or runtime reads as
 * code to run. Copied from server/src/workspace/bellows-cache.ts, which refuses them at parse time.
 */
const CACHE_REFUSED_NAMES: ReadonlySet<string> = new Set([
    'HOME',
    'PATH',
    'SHELL',
    'ENV',
    'BASH_ENV',
    'XDG_DATA_HOME',
    'NPM_CONFIG_UPDATE_NOTIFIER',
    'NODE_OPTIONS',
    'NODE_PATH',
    'PYTHONPATH',
    'PYTHONSTARTUP',
    'PERL5OPT',
    'RUBYOPT',
    'JAVA_TOOL_OPTIONS',
    ...RESERVED_ENV_NAMES,
]);
const CACHE_REFUSED_PREFIXES = [
    'RUNNER_',
    'OTEL_',
    'FACTORY_',
    'BELLOWS_',
    'CLAUDE_',
    'OPENCODE_',
    'GIT_',
    'LD_',
    'DYLD_',
];
const CACHE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/;
const REPO_SEGMENT = /^[A-Za-z0-9._-]+$/;

const cacheNameAllowed = (name: string): boolean =>
    CACHE_NAME.test(name) &&
    !CACHE_REFUSED_NAMES.has(name) &&
    !CACHE_REFUSED_PREFIXES.some((prefix) => name.startsWith(prefix));

/** The `owner/repo` label as two path segments, or null when it cannot name a directory. */
function cacheRepoSegments(label: string | null | undefined): [string, string] | null {
    const [owner = '', repo = '', ...rest] = (label ?? '').split('/');
    const bad = (s: string) => s === '.' || s === '..' || !REPO_SEGMENT.test(s);
    return rest.length || bad(owner) || bad(repo) ? null : [owner, repo];
}

/**
 * Why the job's declared package cache cannot be honoured, or null. The loop fails such a claim
 * with this reason (`claimRefusal`, and again after the gates re-read) — a throw from the env
 * builders would leave the job to its lease, reclaimed on every expiry.
 */
export function repoCacheProblem(job: CacheJob): string | null {
    const names = job.gates?.cache ?? [];
    if (names.length === 0) return null;
    if (!cacheRepoSegments(job.repo)) {
        return `its repo label cannot hold a package cache directory (${job.repo ?? 'none'})`;
    }
    const refused = names.find((name) => !cacheNameAllowed(name));
    return refused === undefined
        ? null
        : `its .bellows.yaml declares a package cache name the driver will not set: ${refused}`;
}

/**
 * Issue #734: each `environment.cache` name `.bellows.yaml` declares, pointed at
 * `<member>/.cache/<owner>/<repo>/<NAME>` — inside the member mount every runner and gate already
 * carries, so it outlives the container and needs no mount of its own. Runner and gate env, both
 * executors, one path. A default only, like `npmQuietEnv`: a claim that names it wins.
 */
export function repoCacheEnv(
    config: Pick<DriverConfig, 'workspaceMount'>,
    job: CacheJob | undefined
): [string, string][] {
    const names = job?.gates?.cache ?? [];
    if (!job || names.length === 0) return [];
    // Unreachable past the loop's refusal; the assertion stands before any path is composed.
    const problem = repoCacheProblem(job);
    const segments = cacheRepoSegments(job.repo);
    if (problem || !segments) throw new Error(`refusing to run job ${job.id}: ${problem}`);
    const dir = `${config.workspaceMount}/${workspacePath(job)}/.cache/${segments[0]}/${segments[1]}`;
    return names.filter((name) => !Object.hasOwn(job.env ?? {}, name)).map((name) => [name, `${dir}/${name}`]);
}

/**
 * The gate env's own literals, rendered as `-e` by docker and as container env by kubernetes. HOME
 * for the non-root uid — /tmp is world-writable where the image's own is not.
 */
export function gateEnv(config: Pick<DriverConfig, 'workspaceMount'>, job: CacheJob | undefined): [string, string][] {
    return [['HOME', '/tmp'], ...npmQuietEnv(job), ...repoCacheEnv(config, job)];
}

/**
 * The environment the board resolved for this job, minus the reserved names. Pure and exported for
 * the pinned-argv test — this is the boundary where a claim's secrets become this process's data.
 *
 * The accumulator is prototype-less and the passEnv filter below checks own properties: names like
 * `__proto__` or `toString` pass the board's name validation, and both would otherwise be silently
 * dropped or wrongly shadow an operator's `RUNNER_ENV` name.
 */
export function claimEnv(job: BoardJob): Record<string, string> {
    const env: Record<string, string> = Object.create(null);
    for (const [name, value] of Object.entries(job.env ?? {})) {
        if ((RESERVED_ENV_NAMES as readonly string[]).includes(name) || name.startsWith(LOADER_ENV_PREFIX)) continue;
        env[name] = value;
    }
    return env;
}

/**
 * `claimEnv`, plus the reserved OpenCode `factory` agent merged into `OPENCODE_CONFIG_CONTENT`
 * (issue #244) — the one place this overlay happens, so the real runner Secret/env-file and the
 * pod spec's key names (kubernetes) can never drift onto two different merges. Never applied to
 * an aux container (sync, gates, publish, helpers): none of them runs the agent CLI, so none of
 * them needs the reserved agent at all. Claude-code claims pass through untouched — the master
 * prompt reaches that CLI as an argv flag, never through env.
 */
export function runnerClaimEnv(job: BoardJob): Record<string, string> {
    const env = claimEnv(job);
    if (job.executorType !== OPENCODE) return env;
    return { ...env, OPENCODE_CONFIG_CONTENT: opencodeConfigContent(job, env.OPENCODE_CONFIG_CONTENT) };
}

/**
 * Whether the claim CONTINUES a session rather than starting a task: a follow-up, or a takeover or
 * handover of the row's own attempt, which resumes that attempt's session (issue #822). The task is
 * mid-flight, and the startup git work is a RESTORE, not a
 * sync — no fetch, no rebase onto the remote default (issue #58): the conversation's tree is
 * what the run continues from, and moving its base underneath it is the mid-task "sync with
 * main" the follow-up flow must not do. A re-claim whose attempt reported no session, or one that
 * spends an attempt past the interruption budget (the board clears its session), starts — and
 * syncs — fresh. Shared with the kubernetes runner, which must restore identically.
 */
export const claimContinuesSession = (job: BoardJob): boolean => job.followUp || job.resumeSessionId !== null;

/** The runner's deadline never reaches zero, even when setup used up its whole share. */
const MIN_RUN_TIMEOUT_MS = 1_000;

/**
 * The run budget less what `environment.setup` already spent of it before the agent started
 * (`job.setupMs`, issue #733): setup counts against the run deadline, not the gate budget.
 */
export const runTimeoutMs = (config: { jobTimeoutMs: number }, job: BoardJob): number =>
    Math.max(MIN_RUN_TIMEOUT_MS, config.jobTimeoutMs - (job.setupMs ?? 0));

/**
 * The pre-agent `environment.setup` timeout (issue #733): the gate budget, but never more than half
 * the run budget, so a hung install always leaves the agent a reserve.
 */
export const setupTimeoutMs = (config: { jobTimeoutMs: number; gateTimeoutMs: number }): number =>
    Math.min(config.gateTimeoutMs, Math.floor(config.jobTimeoutMs / 2));

/**
 * One `NAME=value` line, refusing a newline in either half: the file is line-structured and docker
 * has no quoting for it, so a multiline value would arrive truncated with no error anywhere. The
 * board refuses one at PUT time; this is the driver's own line of defence against rows that
 * predate that check. The refusal names WHICH half carries the newline — blaming the name for the
 * value's offence sends a reader hunting through the env scopes for a variable that is fine.
 */
const envLine = (job: BoardJob, name: string, value: string): string => {
    if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
        const part = /[\r\n]/.test(name) ? 'name' : 'value';
        throw new Error(
            `refusing to write env file for job ${job.id}: the ${part} of "${name}" contains a newline, which an env file cannot carry`
        );
    }
    return `${name}=${value}`;
};

/**
 * The `--env-file` body carrying the supervisor's control pair under the names a container reads it
 * by: the supervisor's own (`name` = `source`) or the exporter's (`BELLOWS_CONTROL_*`). Nothing
 * else of the claim rides it — these two lines are the whole credential.
 */
export function supervisorEnvFileBody(job: BoardJob, pairs: readonly { name: string; source: string }[]): string {
    const lines = pairs.flatMap(({ name, source }) => {
        const value = job.supervisorEnv?.[source];
        return value === undefined ? [] : [envLine(job, name, value)];
    });
    return lines.length ? `${lines.join('\n')}\n` : '';
}

/**
 * The `--env-file` body for the runner: the claim env's lines, then the loop's minted gate
 * credentials, then the runner's own branch-ingest credential. Pure and exported for the same
 * pinning as dockerArgs. The config argument is optional and only ever adds the attempt pair —
 * aux containers (sync, publish, gates) are called without it and get no credential, because
 * none of them reports telemetry.
 */
export function envFileBody(job: BoardJob, config?: DriverConfig): string {
    // The reserved-agent overlay only ever applies to the real runner — every aux container
    // (sync, gates, publish, block-helpers) calls this with no config and gets the plain claim env.
    const lines = Object.entries(config ? runnerClaimEnv(job) : claimEnv(job)).map(([name, value]) =>
        envLine(job, name, value)
    );
    // The driver's own gate credentials go LAST. Docker's --env-file is last-duplicate-wins, so
    // the order is the precedence rule: a `BELLOWS_GATE_TOKEN` a member configured in any env
    // scope was already dropped from the claim lines (reserved names), and the lines here are the
    // driver's minted values — but keeping them visually and structurally after the claim's is
    // what makes "the driver wins a collision" readable in one place.
    for (const [name, value] of Object.entries(job.gateEnv ?? {})) {
        lines.push(envLine(job, name, value));
    }
    // The attempt pair is the one driver-side credential in the file, and it goes after
    // everything: same precedence rule, and the lines a reader audits for "what can authenticate
    // as this runner" are always the last ones. The reporter presents them as headers, and the
    // board resolves the org from the live attempt itself — never from the report's repo.
    if (config) {
        lines.push(envLine(job, 'RUNNER_JOB_ID', job.id));
        lines.push(envLine(job, 'RUNNER_LEASE_TOKEN', job.leaseToken));
    }
    return lines.length ? `${lines.join('\n')}\n` : '';
}

/**
 * A gate environment's env-file body: the claim env's lines, then the board's GitHub token the loop
 * fetched at gate start (docs/connections.md). Fetched once and never renewed — a gate environment
 * that outlives the token's hour runs its later gates on an expired one (docs/connections.md). Never
 * the runner's file: the agent's own git and gh renew through the image's helper instead.
 */
export function gateEnvBody(job: BoardJob, githubToken: string | null): string {
    const body = envFileBody(job);
    return githubToken ? `${body}${envLine(job, 'GITHUB_TOKEN', githubToken)}\n` : body;
}
