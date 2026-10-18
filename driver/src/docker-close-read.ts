/**
 * The docker side of the close-time reads and the live cache watch: the argv of each throwaway
 * container that scrapes a run's session database, and the runner steps that spawn them and fold
 * the answer into the outcome — and the same reads over an earlier claim's exited runner, adopted
 * (issue #792). The parsing and the policy are executor-neutral, in close-read.ts.
 */

import { type BoardJob, UUID_SHAPE } from './board.js';
import {
    CACHE_WATCH_TURNS,
    mergeOpencodeOutcome,
    opencodeReadFailed,
    parseOpencodeRunOutcome,
    readOpencodeWithRetries,
    readsAgentTurns,
    parseClaudeCloseRead,
    mergeClaudeCloseRead,
    CLAUDE_READ_NONE,
    parseOpencodeCacheProbe,
    cacheCollapse,
} from './close-read.js';
import { type DriverConfig, executorImage } from './config.js';
import { claudeTurnsScript, opencodeCacheProbeScript } from './container-scripts.js';
import { UUID, workspacePath, transcriptDir, opencodeDbPath } from './claim.js';
import { type ExecDocker, linesOf, type Spawn, readUtf8 } from './docker-runner-support.js';
import { awaitSupervisor, supervisorLossOf } from './docker-group.js';
import { readDockerKills } from './docker-teardown.js';
import { adoptedVerdictOf, infraLossOf, killEndsGroup } from './termination.js';
import { SUPERVISOR_EXIT } from './supervisor-contract.js';
import {
    containerName,
    workspacesMountArgs,
    opencodeSessionReadoutArgs,
    containerHardeningArgs,
    CLOSE_READ_DEADLINE_MS,
} from './docker.js';
import {
    type AdoptedRun,
    appendTailKept,
    commandMark,
    type KeptLog,
    type RunOutcome,
    type RunSession,
    reportTail,
} from './runner.js';
import { OPENCODE } from './executors.js';
import { CLAIM_SEQ_MARK, COMMAND_MARK, JOB_LABEL, LEASE_LABEL, SESSION_MARK } from './labels.js';

/**
 * The full `docker run` argv that counts the agent turns a finished claude-code run banked —
 * pure, and exported, because it is the part worth pinning. The same throwaway shape the
 * opencode readout runs: a container over the workspaces volume, entrypoint swapped for node,
 * reading the transcript the CLI wrote onto the volume under FACTORY_TRANSCRIPT_DIR (its
 * CLAUDE_CONFIG_DIR). It runs AFTER the job container exits; the volume outlives the container,
 * so there is no teardown to race and a killed run's transcript is still readable.
 */
export function claudeTurnsArgs(config: DriverConfig, job: BoardJob, sessionId: string, startedAt: string): string[] {
    if (!UUID.test(sessionId)) {
        throw new Error(`refusing to count turns for a session id that is not a uuid: ${sessionId}`);
    }
    return [
        'run',
        ...containerHardeningArgs(),
        '--rm',
        ...workspacesMountArgs(config, workspacePath(job)),
        // Both travel as env VALUES — the script (claude-turns.cjs) is static, so nothing
        // board-derived is ever part of its text.
        '-e',
        `CLAUDE_TRANSCRIPT_DIR=${transcriptDir(config, job)}`,
        '-e',
        `CLAUDE_SESSION_ID=${sessionId}`,
        // The run's start as an ISO instant: the transcript carries every cycle the resumed
        // conversation ever had, so the count is bounded to the entries written at or after
        // this run began — its own delta, never the earlier runs' turns again.
        '-e',
        `RUN_STARTED_AT=${startedAt}`,
        '--entrypoint',
        'node',
        executorImage(config, job.executorType),
        '-e',
        claudeTurnsScript,
    ];
}

/**
 * The full `docker run` argv that reads the cache health of a LIVE run — pure, and exported,
 * because it is the part worth pinning: one throwaway container over the workspaces volume,
 * entrypoint swapped for node, read-only query for the newest root session's newest completed
 * assistant turns. Runs every CACHE_WATCH_POLL_MS of the run's life; the same
 * concurrent-reader-with-a-live-writer property the close-time readout relies on, and the same
 * one-error-line rule — an answer that parses to no session is "not yet", not a verdict.
 */
export function opencodeCacheProbeArgs(config: DriverConfig, job: BoardJob): string[] {
    const db = opencodeDbPath(config, job);
    return [
        'run',
        ...containerHardeningArgs(),
        '--rm',
        ...workspacesMountArgs(config, workspacePath(job)),
        // The database path and the turn count travel as env VALUES — the script
        // (opencode-cache-probe.cjs) is static, and the count comes from this module's constant,
        // so the trigger cannot drift between the probe and the code that judges the turns.
        '-e',
        `OPENCODE_DB=${db}`,
        '-e',
        `CACHE_WATCH_TURNS=${CACHE_WATCH_TURNS}`,
        '--entrypoint',
        'node',
        executorImage(config, job.executorType),
        '-e',
        opencodeCacheProbeScript,
    ];
}

/** What every close-time read needs: how to reach the daemon, and which run it is reading. */
export interface CloseReadContext {
    execDocker: ExecDocker;
    config: DriverConfig;
    job: BoardJob;
    startedAt: string;
}

/**
 * Fills in what opencode's own exit code cannot answer: the session id the loop had none to
 * report at spawn, the finish reason (a zero exit with a finish reason that is not `stop` is the
 * model's context limit, or an abort, cutting a task short), and the context stats — all read
 * from the database the run just closed. A failed read is not a failed run: it costs the task
 * its follow-ups and this verdict-check, never its verdict. The session export (raw rows and the
 * normalized stream) rides the same read, so it is one consistent snapshot with the figures.
 */
async function applyOpencodeCloseRead(outcome: RunOutcome, ctx: CloseReadContext): Promise<void> {
    const readOnce = () =>
        ctx.execDocker(opencodeSessionReadoutArgs(ctx.config, ctx.job, ctx.startedAt)).then(
            (read) => parseOpencodeRunOutcome(read.stdout),
            (err: Error) => opencodeReadFailed(`the readout container failed: ${err.message}`)
        );
    const { scraped, reason } = await readOpencodeWithRetries(readOnce, (ms) => new Promise((r) => setTimeout(r, ms)));
    mergeOpencodeOutcome(outcome, scraped, reason);
}

/**
 * The claude-code turn count: one throwaway container over the workspaces volume, reading the
 * transcript the CLI wrote onto it while it lived. Best-effort like every close-time read — a
 * failed read costs the task its agent-turn figure, never its verdict, and a missing transcript
 * answers null rather than zero.
 */
async function applyClaudeCloseRead(
    outcome: RunOutcome,
    ctx: CloseReadContext,
    session: RunSession | null
): Promise<void> {
    if (!readsAgentTurns(ctx.job, session)) return;
    const read = await ctx
        .execDocker(claudeTurnsArgs(ctx.config, ctx.job, (session as RunSession).id, ctx.startedAt), {
            timeout: CLOSE_READ_DEADLINE_MS,
        })
        .then(
            (out) => parseClaudeCloseRead(out.stdout),
            () => CLAUDE_READ_NONE
        );
    mergeClaudeCloseRead(outcome, read);
}

/**
 * Every close-time read this runner performs after a container exits: opencode's session scrape
 * (job.executorType === OPENCODE only), then claude-code's agent-turn count (readsAgentTurns
 * decides). Mutates and answers the same outcome object verdict() produced.
 */
export async function applyCloseTimeReadout(
    outcome: RunOutcome,
    ctx: CloseReadContext,
    session: RunSession | null
): Promise<RunOutcome> {
    if (ctx.job.executorType === OPENCODE) {
        await applyOpencodeCloseRead(outcome, ctx);
    }
    await applyClaudeCloseRead(outcome, ctx, session);
    return outcome;
}

/**
 * One cache-watch tick: probes the run's live opencode session and kills the job once
 * `cacheCollapse` says the provider has stopped serving cache hits. A probe that fails once (the
 * daemon is busy, the session is not there yet) just waits for the next tick — the trigger itself
 * needs consecutive damning turns, so no single answer is fatal. A no-op once `cacheLost` is
 * already set: the kill already fired, and there is nothing left to detect.
 */
export async function tickCacheWatch(
    ctx: { execDocker: ExecDocker; config: DriverConfig; job: BoardJob; kill: (job: BoardJob) => Promise<void> },
    state: { cacheLost: string | null }
): Promise<void> {
    const probe = await ctx
        .execDocker(opencodeCacheProbeArgs(ctx.config, ctx.job))
        .then((read) => parseOpencodeCacheProbe(read.stdout))
        .catch(() => null);
    if (!probe || !probe.sessionId || state.cacheLost) return;
    const collapse = cacheCollapse(probe.turns);
    if (collapse) {
        state.cacheLost = collapse;
        void ctx.kill(ctx.job);
    }
}

/** The fields of each listed container the adoption reads, tab-separated. */
const ADOPT_FORMAT = [LEASE_LABEL, CLAIM_SEQ_MARK, SESSION_MARK, COMMAND_MARK].reduce(
    (format, label) => `${format}\t{{.Label "${label}"}}`,
    '{{.Names}}'
);

/** The newest EXITED runner container of an earlier claim of this job, by claim sequence; null when none. */
async function exitedEarlierRunner(
    execDocker: ExecDocker,
    job: BoardJob
): Promise<{ prior: BoardJob; claimSeq: number; session: string | null } | null> {
    const listed = await execDocker([
        'ps',
        '-a',
        '--filter',
        `label=${JOB_LABEL}=${job.id}`,
        '--filter',
        'status=exited',
        '--format',
        ADOPT_FORMAT,
    ]);
    let newest: { prior: BoardJob; claimSeq: number; session: string | null } | null = null;
    for (const line of linesOf(listed.stdout)) {
        const [name, lease = '', seq = '', session = '', command = ''] = line.split('\t');
        // A queued task's command edited since the run (after a handover) makes that run not its own.
        if (!UUID_SHAPE.test(lease) || !/^\d+$/.test(seq) || command !== commandMark(job.command)) continue;
        const prior = { ...job, leaseToken: lease };
        // Only the runner itself: a service, gate or exporter container carries a name of its own.
        if (name !== containerName(prior)) continue;
        const claimSeq = Number(seq);
        if (claimSeq >= job.claimSeq || (newest && newest.claimSeq >= claimSeq)) continue;
        newest = { prior, claimSeq, session: session || null };
    }
    return newest;
}

/**
 * The exited runner's whole log, streamed into the tail-kept accumulator the attached run keeps —
 * never buffered whole through an exec, whose output cap would fail the adoption of a long run
 * (issue #825). Rejects when `docker logs` does not exit 0.
 */
function readRunnerLog(spawnFn: Spawn, name: string): Promise<KeptLog> {
    return new Promise((resolve, reject) => {
        const child = spawnFn('docker', ['logs', name], { stdio: ['ignore', 'pipe', 'pipe'] });
        let kept: KeptLog = { content: '', truncated: false };
        const collect = (text: string) => {
            kept = appendTailKept(kept, text);
        };
        readUtf8(child.stdout, collect);
        readUtf8(child.stderr, collect);
        child.on('error', reject);
        child.on('close', (code) =>
            code === 0 ? resolve(kept) : reject(new Error(`docker logs ${name} exited ${code ?? 'on a signal'}`))
        );
    });
}

/**
 * The docker `Runner.adopt` (issue #792): a driver restarted while its runner container ran on, and
 * the claim that superseded it reads the container that has since exited — its exit code, its log,
 * the close-time session readouts — exactly as the attached run would have, then runs the re-claim
 * `fence` the skipped sync would have run, which removes it and everything else the earlier
 * attempt left. A timeout the dead driver enforced reads as the exit it caused: the deadline died
 * with it.
 */
export async function dockerAdopt(
    deps: { execDocker: ExecDocker; spawnFn: Spawn; config: DriverConfig; fence: (job: BoardJob) => Promise<void> },
    job: BoardJob
): Promise<AdoptedRun | null> {
    const { execDocker, config } = deps;
    const found = await exitedEarlierRunner(execDocker, job);
    if (!found) return null;
    const { prior, claimSeq, session } = found;
    // The agent's exit is not the run's end: its supervisor may still be draining the exporter and
    // finalizing (the dead driver never waited for it). Waited out, bounded — never swept unread —
    // and a supervisor that ended any way but finalizing is a run the platform took away, which
    // the sync's re-claim fence takes as ever.
    // Why the lost driver ended the run, when it did, was recorded on the attempt before its kill: a
    // hard kill explains the supervisor's exit, and every reason is the verdict it was live.
    const supervisorExit = await awaitSupervisor(execDocker, prior);
    const kills = await readDockerKills(execDocker, prior);
    const timedOut = supervisorExit === SUPERVISOR_EXIT.deadline || kills.some((kill) => kill.reason === 'timeout');
    const loss = infraLossOf({
        killedByDriver: kills.some((kill) => killEndsGroup(kill.reason)),
        timedOut,
        reported: false,
        vanished: null,
        unfinalized: supervisorLossOf(supervisorExit, false),
    });
    if (loss) return null;
    const name = containerName(prior);
    const state = JSON.parse((await execDocker(['inspect', '--format', '{{json .State}}', name])).stdout) as {
        ExitCode?: number;
        StartedAt?: string;
    };
    const full = await readRunnerLog(deps.spawnFn, name);
    const outcome: RunOutcome = {
        exitCode: state.ExitCode ?? null,
        output: reportTail(full.content),
        // A budget the supervisor enforced reads as the exit it caused: its own 124.
        timedOut,
        started: true,
        fullLog: full.content,
        logTruncated: full.truncated,
        ...adoptedVerdictOf(kills),
    };
    const startedAt = state.StartedAt ?? new Date(0).toISOString();
    await applyCloseTimeReadout(
        outcome,
        { execDocker, config, job: prior, startedAt },
        session ? { id: session, resume: false } : null
    );
    if (session && !outcome.sessionId) outcome.sessionId = session;
    await deps.fence(job);
    return { outcome, claimSeq };
}
