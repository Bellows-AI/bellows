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
import {
    boundedExec,
    type ExecDocker,
    noSuchObject,
    readDocker,
    tabRows,
    type Spawn,
    readUtf8,
} from './docker-runner-support.js';
import { abortableSleep, anyOf, type Bound, type Sleep, timeLeft } from './poll.js';
import { supervisorLossOf, waitSupervisorExit } from './docker-group.js';
import { supervisorName } from './docker-mailbox.js';
import { readDockerKills } from './docker-teardown.js';
import { type AdoptPrimitives, adoptEarlierRun, type EarlierRun } from './adopt-skeleton.js';
import type { KillLedger } from './kill-ledger.js';
import { type FinalReport, finalReportOf, SUPERVISOR_EXIT, SUPERVISOR_WINDDOWN_MS } from './supervisor-contract.js';
import { containerName, workspacesMountArgs, opencodeSessionReadoutArgs, containerHardeningArgs } from './docker.js';
import {
    AdoptionBlocked,
    type AdoptedRun,
    adoptionAbandoned,
    appendTailKept,
    CLOSE_READ_DEADLINE_MS,
    Inconclusive,
    type KeptLog,
    type RunOutcome,
    type RunSession,
    reportTail,
} from './runner.js';
import { OPENCODE } from './executors.js';
import { CLAIM_SEQ_MARK, COMMAND_MARK, isCommandMark, isSeq, JOB_LABEL, LEASE_LABEL, SESSION_MARK } from './labels.js';

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
    /** The attempt's kill: it ends the readout's retries, which then stand on their latest answer. */
    signal?: AbortSignal;
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
    const readOnce = (deadline: number) =>
        ctx
            .execDocker(opencodeSessionReadoutArgs(ctx.config, ctx.job, ctx.startedAt), {
                timeout: timeLeft(deadline),
                ...(ctx.signal ? { signal: ctx.signal } : {}),
            })
            .then(
                (read) => parseOpencodeRunOutcome(read.stdout),
                (err: Error) => opencodeReadFailed(`the readout container failed: ${err.message}`)
            );
    const { scraped, reason } = await readOpencodeWithRetries(readOnce, abortableSleep, ctx.signal);
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
            ...(ctx.signal ? { signal: ctx.signal } : {}),
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
const ADOPT_LABELS = [LEASE_LABEL, CLAIM_SEQ_MARK, SESSION_MARK, COMMAND_MARK];
const ADOPT_FORMAT = ADOPT_LABELS.reduce((format, label) => `${format}\t{{.Label "${label}"}}`, '{{.Names}}');

/**
 * A listed container's discovery labels (#869). A label it carries must be well formed — a lease, a
 * claim sequence in digits within the safe integers — or skipping it would read an earlier run as no
 * run. The runner itself (the name `containerName` gives its lease) must carry all of them: its lease
 * label the one its name spells, a claim sequence and a command mark. A container with neither
 * label is no runner. Throws when the listing cannot be trusted; true for the runner of `job`.
 */
function isRunnerRow(job: BoardJob, [name, lease, seq, , command]: string[]): boolean {
    const label = `listing the exited earlier runners: ${name}`;
    if ((lease !== '' && !UUID_SHAPE.test(lease!)) || (seq !== '' && !isSeq(seq))) {
        throw new Error(`${label} carries a malformed lease or claim sequence`);
    }
    const namedLease = name!.startsWith(`factory-job-${job.id}-`) ? name!.slice(`factory-job-${job.id}-`.length) : '';
    if (!UUID_SHAPE.test(namedLease)) return false;
    if (lease !== namedLease || !isSeq(seq) || !isCommandMark(command)) {
        throw new Error(`${label} is a runner without its lease, claim sequence or command mark`);
    }
    return true;
}

/** Every EXITED runner container of this job's claims (the skeleton picks the newest earlier one). */
async function exitedRunners(execDocker: ExecDocker, job: BoardJob): Promise<DockerEarlier[]> {
    // A listing that is refused or is no rows of five fields throws: it is never "no earlier run",
    // which would hand the exited run to a fresh run's fence to remove unread (#869).
    const listed = await readDocker(
        execDocker,
        ['ps', '-a', '--filter', `label=${JOB_LABEL}=${job.id}`, '--filter', 'status=exited', '--format', ADOPT_FORMAT],
        'listing the exited earlier runners',
        { parse: tabRows(ADOPT_LABELS.length + 1) }
    );
    if (listed.kind !== 'value') {
        throw new Error(listed.kind === 'inconclusive' ? listed.reason : 'listing the exited earlier runners: absent');
    }
    const runners: DockerEarlier[] = [];
    for (const row of listed.value) {
        const [name = '', lease = '', seq = '', session = '', command = ''] = row;
        if (!isRunnerRow(job, [name, lease, seq, session, command])) continue;
        // A queued task's command edited since the run (after a handover) makes that run not its own:
        // another valid mark, unlike an unreadable one (thrown above).
        runners.push({
            prior: { ...job, leaseToken: lease },
            claimSeq: Number(seq),
            commandMark: command,
            session: session || null,
            supervisorExit: null,
        });
    }
    return runners;
}

/** An exited earlier runner; `supervisorExit` is how its supervisor ended, once waited for. */
interface DockerEarlier extends EarlierRun {
    supervisorExit: number | null;
}

/**
 * The exited runner's whole log, streamed into the tail-kept accumulator the attached run keeps —
 * never buffered whole through an exec, whose output cap would fail the adoption of a long run
 * (issue #825). Rejects when `docker logs` does not exit 0.
 */
function readRunnerLog(spawnFn: Spawn, name: string, { deadline, signal }: Bound): Promise<KeptLog> {
    return new Promise((resolve, reject) => {
        // The stream ends at the operation's deadline and on the attempt's kill: spawn terminates the child on abort.
        const late = new AbortController();
        const timer = setTimeout(() => late.abort(), timeLeft(deadline));
        const child = spawnFn('docker', ['logs', name], {
            stdio: ['ignore', 'pipe', 'pipe'],
            signal: anyOf(signal, late.signal),
        });
        let kept: KeptLog = { content: '', truncated: false };
        const collect = (text: string) => {
            kept = appendTailKept(kept, text);
        };
        readUtf8(child.stdout, collect);
        readUtf8(child.stderr, collect);
        child.on('error', (e) => {
            clearTimeout(timer);
            reject(e);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) resolve(kept);
            else reject(new Error(`docker logs ${name} exited ${code ?? 'on a signal'}`));
        });
    });
}

/** An exited runner's state as `inspect` answers it: its exit code, or `Inconclusive` for anything else. */
function runnerStateOf(read: string): { ExitCode: number; StartedAt?: string } {
    let state: unknown;
    try {
        state = JSON.parse(read);
    } catch {
        throw new Inconclusive('the exited runner inspect answered a body that is not JSON');
    }
    const { ExitCode, StartedAt } = (state ?? {}) as { ExitCode?: unknown; StartedAt?: unknown };
    if (typeof ExitCode !== 'number') throw new Inconclusive('the exited runner inspect answered no exit code');
    return typeof StartedAt === 'string' ? { ExitCode, StartedAt } : { ExitCode };
}

/** The last lines of a supervisor's log the final report is the last of. */
const REPORT_LOG_TAIL = '20';

/**
 * The final report the earlier supervisor logged; null when it logged none, or its container is
 * gone. A log the daemon would not serve is no answer — "no report" would make a supervisor that
 * reported and then crashed a loss, swept unread — so the attempt stands down instead.
 */
async function readSupervisorReport(execDocker: ExecDocker, prior: BoardJob): Promise<FinalReport | null> {
    let log: string;
    try {
        log = (await execDocker(['logs', '--tail', REPORT_LOG_TAIL, supervisorName(prior)])).stdout;
    } catch (e) {
        if (noSuchObject(e, ['container', 'object'])) return null;
        throw new AdoptionBlocked(`the earlier supervisor's report could not be read: ${(e as Error).message}`);
    }
    return finalReportOf(log);
}

/**
 * The docker `Runner.adopt` (issue #792): a driver restarted while its runner container ran on, and
 * the claim that superseded it reads the container that has since exited — its exit code, its log,
 * the close-time session readouts — exactly as the attached run would have, then runs the re-claim
 * `fence` the skipped sync would have run, which removes everything older attempts left. The read
 * run itself is kept (`adopted`, issue #821), as the kubernetes adoption keeps its Job: a claim lost
 * before its verdict lands leaves it for the next to adopt, and the reaper takes it once the job is
 * terminal. A timeout the dead driver enforced reads as the exit it caused: the deadline died with it.
 */
export function dockerAdopt(deps: AdoptDeps, job: BoardJob, signal?: AbortSignal): Promise<AdoptedRun | null> {
    // The supplied stand-down and the attempt's kill end every request, pause and stream of the adoption.
    return adoptEarlierRun(dockerAdoption(deps), deps.adopted, job, anyOf(signal, deps.ledger.signal(job)));
}

/** How often the adoption lists the exited runners before a refusing daemon stands the attempt down. */
const DISCOVERY_ATTEMPTS = 3;
/** The pause between those listings — the kubernetes listing's pace (`POLL_MS`). */
const DISCOVERY_RETRY_MS = 2_000;

interface AdoptDeps {
    execDocker: ExecDocker;
    sleep: Sleep;
    spawnFn: Spawn;
    config: DriverConfig;
    ledger: KillLedger;
    fence: (job: BoardJob, signal: AbortSignal) => Promise<void>;
    adopted: Map<string, string>;
}

/** What differs in docker's adoption: its listing, the supervisor's wait, the reads of the exited run, the fence. */
function dockerAdoption(deps: AdoptDeps): AdoptPrimitives<DockerEarlier> {
    const { execDocker, config } = deps;
    return {
        // A daemon that could not say is no "nothing to adopt": a fresh run's fence would remove a
        // finalizing group unread once it answers again (#824).
        pacing: { attempts: DISCOVERY_ATTEMPTS, retryMs: DISCOVERY_RETRY_MS, sleep: deps.sleep },
        list: (job, bound) => exitedRunners(boundedExec(execDocker, bound), job),
        begin: async () => undefined,
        // The agent's exit is not the run's end: its supervisor may still be draining the exporter and
        // finalizing (the dead driver never waited for it). Waited out, bounded — never swept unread —
        // and a supervisor that ended any way but finalizing is a run the platform took away, which
        // the sync's re-claim fence takes as ever.
        awaitEnd: async (found, _job, signal) => {
            const supervisorExit = await waitSupervisorExit(
                execDocker,
                found.prior,
                SUPERVISOR_WINDDOWN_MS,
                signal
            ).catch((e: Error) => {
                throw new AdoptionBlocked(`the earlier supervisor could not be waited for: ${e.message}`);
            });
            if (signal?.aborted) throw adoptionAbandoned();
            return { ...found, supervisorExit };
        },
        // Why the lost driver ended the run, when it did, was recorded on the attempt before its kill: a
        // hard kill explains the supervisor's exit, and every reason is the verdict it was live; so does
        // the final report the supervisor logged, which a crash after it does not unsay (#824).
        read: async ({ prior, supervisorExit }, _job, signal) => {
            // One absolute deadline for the evidence and the body read after it, ended by the kill.
            const bound: Bound = { deadline: Date.now() + CLOSE_READ_DEADLINE_MS, signal };
            const bounded = boundedExec(execDocker, bound);
            const kills = await readDockerKills(bounded, prior);
            const report = await readSupervisorReport(bounded, prior);
            return {
                end: {
                    kills,
                    driverKilledHard: false,
                    report,
                    // A budget the supervisor enforced reads as the exit it caused: its own 124.
                    budgetEnded: supervisorExit === SUPERVISOR_EXIT.deadline,
                    vanished: null,
                    unfinalized: supervisorLossOf(supervisorExit, false),
                },
                body: async () => {
                    const name = containerName(prior);
                    const state = runnerStateOf(
                        (await bounded(['inspect', '--format', '{{json .State}}', name])).stdout
                    );
                    const full = await readRunnerLog(deps.spawnFn, name, bound);
                    return {
                        exitCode: state.ExitCode,
                        output: reportTail(full.content),
                        fullLog: full.content,
                        logTruncated: full.truncated,
                        startedAt: state.StartedAt ?? new Date(0).toISOString(),
                    };
                },
            };
        },
        confirmOwnership: async () => undefined,
        closeReadout: async (outcome, { prior, session }, _job, { startedAt, signal }) => {
            await applyCloseTimeReadout(
                outcome,
                { execDocker, config, job: prior, startedAt, ...(signal ? { signal } : {}) },
                session ? { id: session, resume: false } : null
            );
        },
        recordKey: ({ prior }) => prior.leaseToken,
        // The re-claim fence removes everything older attempts left, the run read spared; a fence that
        // fails leaves the run to the lease, and the next claim reads it again.
        sweep: (_found, job, signal) => deps.fence(job, anyOf(signal)),
        rollback: async () => undefined,
    };
}
