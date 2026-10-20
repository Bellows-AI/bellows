import { CLAIM_SEQ_MARK, COMMAND_MARK, JOB_LABEL, LEASE_LABEL, SERVICE_LABEL, SESSION_MARK } from './labels.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    type DriverConfig,
    type RunnerResources,
    cpuQuantityToCores,
    executorImage,
    memoryQuantityToBytes,
} from './config.js';
import type { BoardJob } from './board.js';
import {
    UUID,
    TOOL_UID,
    AGENT_LAUNCH_CAPS,
    GITHUB_CACHE_DIR,
    GITHUB_CACHE_SIZE,
    opencodeDbPath,
    runWorkingDir,
    runnerClaimEnv,
} from './claim.js';
import { opencodeReadoutScript } from './container-scripts.js';
import { parseLastJsonLine } from './json-parse.js';
import type { ServiceStatus } from './board.js';
import { BYTES_PER_KIB, commandMark, OPENCODE_EXPORT_LIMIT, type RuntimeSample, type RunSession } from './runner.js';
import { taskMountArgs } from './task-volume.js';
import { assertWorktreeResolvable, runnerPlan } from './runner-plan.js';
import { agentMailboxArgs, agentRoleArgs, groupNetworkArgs } from './docker-mailbox.js';

/**
 * The close-time claude-code turn read's whole budget, matching the kubernetes twin's
 * `activeDeadlineSeconds`. The runner's timeout is long gone by the time this read runs, so
 * without a bound of its own a stalled daemon would hold the verdict — and the worker slot —
 * open forever. On expiry the read answers null: unmeasured, never a wrong number.
 */
export const CLOSE_READ_DEADLINE_MS = 120_000;

/**
 * The docker twin of the kubernetes pod hardening (issue #382), on EVERY container this driver
 * runs — the runner, the gates, the readouts, the sync, the reclaim, the publish steps, the block
 * helpers and the declared services. Kubernetes is the primary executor, but docker is the one a
 * developer runs agent-written code under on their own machine, against a daemon that is root on
 * it, so the two controls are spelled here the way docker spells them:
 *
 *   --cap-drop ALL                     the kubernetes `capabilities.drop: [ALL]`
 *   --security-opt no-new-privileges   the kubernetes `allowPrivilegeEscalation: false`
 *
 * There is no seccomp twin, and adding one would be a flag that can only ever be wrong: the daemon
 * already applies its default profile to every container, which is precisely what the kubelet is
 * being asked for by `seccompProfile: RuntimeDefault`.
 *
 * A FUNCTION, not a shared constant: an exported array would be reachable from every argv this
 * process builds, and one caller pushing onto it would disarm all of them.
 */
export const containerHardeningArgs = (): string[] => ['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges'];

/**
 * The agent container's start (issue #814): root, with the two capabilities its tool broker keeps,
 * on top of `containerHardeningArgs`. factory-launch drops both, and root, before the CLI starts.
 */
export const agentLaunchArgs = (): string[] => [
    '--user',
    '0:0',
    ...AGENT_LAUNCH_CAPS.flatMap((cap) => ['--cap-add', cap]),
];

const PERCENT = /^([0-9.]+)%/;
const MEMORY = /^([0-9.]+)\s*([A-Za-z]+)/;

/** Docker's stats units, to MiB. Both the binary and the decimal spellings are seen in the wild. */
const BYTES_PER_MIB = 1_048_576;
const TO_MIB: Record<string, number> = {
    B: 1 / BYTES_PER_MIB,
    kB: 1e-3,
    KB: 1e-3,
    KiB: 1 / BYTES_PER_KIB,
    MB: 1,
    MiB: 1,
    GB: 1e3,
    GiB: 1024,
    TB: 1e6,
    TiB: 1048576,
};

const percentOf = (field: unknown): number | null => {
    const match = typeof field === 'string' ? PERCENT.exec(field.trim()) : null;
    return match ? Number.parseFloat(match[1]!) : null;
};

const memMbOf = (field: string | undefined): number | null => {
    const match = field === undefined ? null : MEMORY.exec(field.trim());
    if (!match) return null;
    const factor = TO_MIB[match[2]!];
    return factor === undefined ? null : Number.parseFloat(match[1]!) * factor;
};

/**
 * Pulls the vitals out of `docker stats --no-stream --format '{{json .}}'` output. Pure and
 * exported for the pinning: the fields are display strings ("93.00%", "544MiB / 7.754GiB") and
 * their parse deserves its own test. Null for anything it cannot read — a missed sample costs
 * freshness, never the run.
 */
export function parseDockerStats(stdout: string): Omit<RuntimeSample, 'sampledAt'> | null {
    const parsed = parseLastJsonLine<unknown>(stdout, () => undefined);
    if (parsed === undefined) return null;
    const fields = parsed as Record<string, unknown>;
    const cpuPercent = percentOf(fields.CPUPerc);
    const usage = typeof fields.MemUsage === 'string' ? fields.MemUsage.split('/') : [];
    const memUsedMb = memMbOf(usage[0]);
    if (cpuPercent === null || memUsedMb === null) return null;
    return { cpuPercent, memUsedMb, memPercent: percentOf(fields.MemPerc) };
}

/**
 * Pulls the service fleet out of `docker ps -a --format '{{json .}}'` over this attempt's label
 * pair. Pure and exported for the pinning. Rows without the `factory.service` label, an image or
 * a state are skipped — never a row the panel could not name — and garbage lines are skipped for
 * the same reason a stats parse skips them. `-a` is what lets an exited service answer honestly:
 * "came up and died" is a state, not an absence.
 */
export function parseDockerServicePs(stdout: string): ServiceStatus[] {
    const out: ServiceStatus[] = [];
    for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let fields: { Labels?: unknown; Image?: unknown; State?: unknown };
        try {
            fields = JSON.parse(trimmed) as { Labels?: unknown; Image?: unknown; State?: unknown };
        } catch {
            continue;
        }
        const labels = typeof fields.Labels === 'string' ? fields.Labels : '';
        const name = labels
            .split(',')
            .find((pair) => pair.startsWith(`${SERVICE_LABEL}=`))
            ?.slice(`${SERVICE_LABEL}=`.length);
        const image = typeof fields.Image === 'string' ? fields.Image : null;
        const state = typeof fields.State === 'string' ? fields.State.toLowerCase() : null;
        if (!name || !image || !state) continue;
        out.push({ name, image, state });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * How a service container ended, off `docker inspect --format '{{json .State}}'` (issue #423):
 * the exit code, and the reason — `OOMKilled` when the kernel killed it, else the daemon's own
 * error, else null. Pure and exported for the pinning; garbage answers both null.
 */
export function parseDockerServiceExit(stdout: string): { exitCode: number | null; reason: string | null } {
    let state: { ExitCode?: unknown; OOMKilled?: unknown; Error?: unknown };
    try {
        state = JSON.parse(stdout) as typeof state;
    } catch {
        return { exitCode: null, reason: null };
    }
    const exitCode = typeof state.ExitCode === 'number' ? state.ExitCode : null;
    if (state.OOMKilled === true) return { exitCode, reason: 'OOMKilled' };
    return { exitCode, reason: typeof state.Error === 'string' && state.Error ? state.Error : null };
}

/**
 * The runner container's name — one per ATTEMPT. The naming contract every per-attempt
 * operation in this file relies on: the lease token is minted fresh on every claim and never
 * repeats, so a name can only ever resolve to the container the attempt that computed it
 * created. A stale attempt can compute the name it used, but that name is structurally incapable
 * of addressing a replacement attempt's runner — which is why its kill, its verdict cleanup and
 * its teardown need no ownership gate. The one job-scoped identifier is the `factory.job` label,
 * and the only thing allowed to act on it is the re-claim fence.
 */
export const containerName = (job: BoardJob): string => `factory-job-${job.id}-${job.leaseToken}`;
/**
 * The full `docker run` argv that reads what a finished opencode run left behind — pure, and
 * exported, because it is the part worth pinning: the readout is a throwaway container over the
 * task volume, entrypoint swapped for node, whose only work is one read-only query pair for
 * the newest root session and the finish reason of its last assistant message.
 *
 * It runs AFTER the job container exits (docker exec cannot), and against the volume rather than
 * inside any container, which is why the run may be over before any of this is known and why the
 * runner reports both in the outcome instead of mid-run. The finish reason is what tells a run
 * that ended itself (`stop`) from one the model's context limit cut short (`length`) — the exit
 * code reads 0 for both, and only one of them is a success.
 */
export function opencodeSessionReadoutArgs(config: DriverConfig, job: BoardJob, startedAt: string): string[] {
    const db = opencodeDbPath(job);
    return [
        'run',
        ...containerHardeningArgs(),
        '--rm',
        ...taskMountArgs(job),
        // The database path and the directory scope travel as env VALUES — the script
        // (opencode-readout.cjs) is static, so nothing board-derived is ever part of its text.
        // The scope is the run's own working directory (runWorkingDir — the same string opencode
        // records on the session), so the scrape answers the root session that ran there. The
        // database itself is the task's own (opencodeDataDir).
        '-e',
        `OPENCODE_DB=${db}`,
        '-e',
        `OPENCODE_DIR=${runWorkingDir(job)}`,
        // The run's start, as epoch ms: the readout counts only the turns created at or after
        // it, because a follow-up resumes the SAME root conversation and counting the whole
        // session would book earlier runs' turns again.
        '-e',
        `RUN_STARTED_MS=${Date.parse(startedAt)}`,
        // The per-stream cap of the session export the readout prints ahead of its answer line.
        '-e',
        `EXPORT_LIMIT_BYTES=${OPENCODE_EXPORT_LIMIT}`,
        '--entrypoint',
        'node',
        executorImage(config, job.executorType),
        '-e',
        opencodeReadoutScript,
    ];
}

/**
 * Where the run's env file lives — one per ATTEMPT, lease token included, so a re-claimed
 * attempt's write can never race a previous attempt's cleanup on the same path. Both halves of the
 * name are asserted before they join a path: the file write is the one place a board-supplied id
 * becomes a filesystem operation. Exported so the argv pins can name the exact file a real run
 * passes to `docker run`.
 */
export const envFilePath = (job: BoardJob): string => {
    if (!UUID.test(job.id)) {
        throw new Error(`refusing to write an env file for a job id that is not a uuid: ${job.id}`);
    }
    if (!UUID.test(job.leaseToken)) {
        throw new Error(`refusing to write an env file for a lease token that is not a uuid: ${job.leaseToken}`);
    }
    return join(tmpdir(), `factory-env-${job.id}-${job.leaseToken}.env`);
};

/**
 * A resource block's caps — the runner's (issue #360), the gate container's (issue #507): the
 * configured limits as docker's own flags, the memory request as the soft `--memory-reservation`
 * floor. Quantities are translated once, in
 * config.ts — the same values the kubernetes pod specs render verbatim. There is no cpu-request
 * flag by decision: docker has no absolute CPU floor (`--cpu-shares` is a relative weight), and
 * capping a runner at its request would throttle builds the kubernetes side leaves free. Empty
 * when nothing is configured — the dev daemon stays unthrottled.
 */
export function resourceArgs(block: RunnerResources): string[] {
    const { cpuLimit, memoryLimit, memoryRequest } = block;
    const args: string[] = [];
    if (cpuLimit) args.push('--cpus', cpuQuantityToCores(cpuLimit));
    if (memoryLimit) args.push('--memory', memoryQuantityToBytes(memoryLimit));
    if (memoryRequest) args.push('--memory-reservation', memoryQuantityToBytes(memoryRequest));
    return args;
}

/**
 * Pushes the runner's credential onto the argv: the driver's passEnv names plus the claim's
 * `--env-file`.
 */
function pushRunnerCredentialArgs(args: string[], config: DriverConfig, job: BoardJob, envFile?: string): void {
    // The driver's own credentials: `-e NAME` without a value, docker reads it
    // from THIS process's environment. `-e NAME=value` would put the credential in an argv
    // every `ps` on the host can read — the same distinction the workspace reconcile makes for
    // the git token.
    //
    // The claim's env does NOT ride as `-e NAME`. Its names are member-controlled, and `-e
    // NAME` reads the value from this process's own environment — a member-configured PATH,
    // DOCKER_HOST or HOME there steers the docker CLI the driver executes on the host, which
    // is host code execution rather than a runner environment. So the claim travels in a
    // --env-file (written and removed by createDockerRunner), the values never touching this
    // process's environment at all. Reserved names are already gone (claimEnv); docker gives
    // `-e` precedence over `--env-file`, so a name the claim also carries is dropped from
    // passEnv — the claim must win. `runnerClaimEnv`, not `claimEnv`: this argv always builds the
    // REAL runner (dockerArgs is never called for an aux container), so an operator who lists
    // `OPENCODE_CONFIG_CONTENT` in RUNNER_ENV must not win a collision against the reserved
    // agent's own merged value the same way any other claim name would.
    const claim = runnerClaimEnv(job);
    // The file is not optional any more, even for a claim that resolves to nothing: the
    // runner's own branch-ingest credential — this attempt's job id + lease token pair —
    // rides it (envFileBody appends it after the claim's and gate lines), and a runner
    // without its file would report 401s into silence.
    if (!envFile) {
        throw new Error(`refusing to run job ${job.id}: no env file was given`);
    }
    for (const name of config.passEnv.filter((n) => !Object.hasOwn(claim, n))) {
        args.push('-e', name);
    }
    args.push('--env-file', envFile);
}

export function dockerArgs(
    config: DriverConfig,
    job: BoardJob,
    session: RunSession | null,
    options: { envFile?: string } = {}
): string[] {
    const { envFile } = options;
    /*
     * The run happens in the job's task worktree (issue #35) — one per task thread, branched off
     * the remote default — when the job names a repository, and at the member root when it does
     * not (a command-only job names no repo, so no worktree exists; the root is where it always
     * started, and the argv stays byte-identical for it). Asserted from the same line the
     * kubernetes runner asserts it from.
     */
    assertWorktreeResolvable(job);
    // `create`, not `run`: the runner is started attached only once its managed settings are in
    // (issue #452, see createRunnerContainer in docker-runner-support.ts).
    const args = [
        'create',
        ...containerHardeningArgs(),
        ...agentLaunchArgs(),
        '--name',
        containerName(job),
        // Two labels, two jobs. `factory.job` is shared by every attempt of the job: it is what
        // `docker ps --filter label=factory.job` finds a runner that outlived its driver by, and
        // what the re-claim fence sweeps by — the one identifier every attempt shares.
        // `factory.lease` is this attempt's alone, and it is what scopes every per-attempt
        // operation (kill, teardown, cleanup) to this attempt's containers: a stale attempt's
        // filters can only ever resolve its own fleet, never a replacement's.
        '--label',
        `${JOB_LABEL}=${job.id}`,
        '--label',
        `${LEASE_LABEL}=${job.leaseToken}`,
        // What the claim that supersedes a dead driver adopts this run by (issue #792).
        '--label',
        `${CLAIM_SEQ_MARK}=${job.claimSeq}`,
        ...(session ? ['--label', `${SESSION_MARK}=${session.id}`] : []),
        '--label',
        `${COMMAND_MARK}=${commandMark(job.command)}`,
        // Which container of the run's group this is: a kill of the agent alone, or the teardown
        // of the supervisor and exporter beside it, tells them apart by it.
        ...agentRoleArgs(),
        '-e',
        // The AUTHOR's checkouts sit one directory down. A command-only job names no repo, so the
        // agent starts at the root of that person's workspace and can see everything they selected
        // — and nothing anybody else selected.
        //
        // This used to be `<mount>/<orgId>`, one tree shared by every member. Neither `<mount>` nor
        // `<mount>/<orgId>` is a safe fallback now: both are the PARENT of every member's tree, and
        // handing that to a container that may be running --dangerously-skip-permissions is a
        // cross-tenant read. So a job with no workspace fails instead — see loop.ts.
        `WORKDIR=${runWorkingDir(job)}`,
        // The thread's own task volume, mounted at TASK_MOUNT: the checkout WORKDIR names lives in
        // it, and no other thread's or member's tree is on the container's filesystem. Enforced by
        // the mount itself; an agent running arbitrary code inside cannot cross it.
        ...taskMountArgs(job),
        // The agent's side of the task supervisor's mailbox: `in` read-only (a Stop, an answer, a
        // kill order — it cannot forge them) and `out` (its questions and heartbeat). Nothing of the
        // supervisor's own state, the exporter's mailbox or the control credential is mounted or set.
        ...agentMailboxArgs(job),
        // The GitHub helper's token cache, in memory and the agent's own (docs/connections.md):
        // never on the task volume, gone with the container.
        '--tmpfs',
        // The tool uid's: git and gh run as it (issue #814).
        `${GITHUB_CACHE_DIR}:rw,noexec,nosuid,size=${GITHUB_CACHE_SIZE.docker},mode=0700,uid=${TOOL_UID}`,
    ];

    // Issue #360 on this side too: the configured requests/limits as resource flags, before the
    // credentials. Nothing configured renders nothing — the argv is exactly what it always was.
    args.push(...resourceArgs(config.runnerResources));

    pushRunnerCredentialArgs(args, config, job, envFile);

    // The group supervisor's network namespace (issue #773), as a pod's containers share one: its
    // RUNNER_NETWORK carries telemetry and the driver's gate endpoint out, and its hosts file maps
    // `host.docker.internal` (automatic on Docker Desktop, not on Linux) and every declared service,
    // on loopback. docker refuses --add-host and a second --network beside it.
    args.push(...groupNetworkArgs(job));
    // Where the runner's telemetry is pointed. The executor image bakes a default endpoint
    // (http://collector:4318), but RUNNER_OTEL_ENDPOINT overrides it for a collector the compose
    // network cannot name — the same override the kubernetes runner applies in the pod spec. A
    // literal value, not a credential: an OTLP endpoint is a URL, and the kubernetes runner
    // already names it in a spec anyone with `get pods` can read. Not `-e NAME`, which would make
    // docker read OTEL_EXPORTER_OTLP_ENDPOINT from this process's environment — a different
    // variable from the RUNNER_OTEL_ENDPOINT this config was built from.
    args.push('-e', `OTEL_EXPORTER_OTLP_ENDPOINT=${config.otelEndpoint}`);

    // Where the runner's branch reporter posts. The board's own URL — the same reasoning as the
    // OTEL endpoint beside it: a literal URL, not a credential. Unset in the config would have
    // refused at boot; the default names the board JOB_BOARD_URL names.
    args.push('-e', `FACTORY_STATS_URL=${config.statsUrl}`);

    // What the executor is asked to do, decided once for both platforms (runner-plan.ts) and
    // RENDERED here in docker's own vocabulary: every env pair as a `-e NAME=value` BEFORE the
    // image name — docker stops option parsing there, and an `-e` past it would be the CLI's own
    // argv — and the plan's cliArgs after it, which is exactly what the image's ENTRYPOINT
    // receives. The values are paths, session ids and the turn context, never credentials;
    // member-scoped values travel in the --env-file above.
    const plan = runnerPlan(config, job, session);
    for (const [name, value] of plan.envPairs) args.push('-e', `${name}=${value}`);
    args.push(executorImage(config, job.executorType), ...plan.cliArgs);
    return args;
}
