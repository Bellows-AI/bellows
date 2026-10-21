import { JOB_LABEL } from './labels.js';
import {
    awaitSupervisor,
    closeEndOf,
    createGroup,
    rebindGroup,
    removeGroup,
    startGroup,
    supervisorLossOf,
} from './docker-group.js';
import { type DockerGateDeps, runDockerGate, runDockerReview } from './docker-gate.js';
import {
    dockerKill,
    dockerKillFor,
    dockerServiceTeardown,
    dockerStopAgent,
    recordDockerKill,
} from './docker-teardown.js';
import { supervisorName } from './docker-mailbox.js';
import { createKillLedger, type KillLedger } from './kill-ledger.js';
import { SUPERVISOR_ENV, SUPERVISOR_EXIT } from './supervisor-contract.js';
import { agentBackstopMs, spentMs } from './supervisor-plan.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import type { BoardJob } from './board.js';
import type { DriverConfig } from './config.js';
import { abortableSleep, anyOf, type Sleep } from './poll.js';
import type { StepSink, SupervisorEndpoint } from './step-control.js';
import {
    attachSteps,
    awaitFirstContact,
    controlTokenOf,
    GROUP_UP_WAIT_MS,
    orderFinish,
    orderGo,
    releaseSteps,
    runReclaimStep,
    runSyncStep,
    type StepHost,
    stepHostOf,
    supervisedStepMembers,
} from './supervised-steps.js';
import { reviewRunOf } from './review-step.js';
import { RELEASE_DEADLINE_MS, repoPath, worktreeDir, type ReclaimResult, type SyncResult } from './publish.js';
import { groupServices, missingDeclaredServices, serviceContainerName } from './services.js';
import {
    containerName,
    parseDockerServiceExit,
    parseDockerServicePs,
    parseDockerStats,
    toolTreeReleaseArgs,
} from './docker.js';
import {
    appendTailKept,
    composeRuntimeSample,
    onOwnGroup,
    type KeptLog,
    reportTail,
    SERVICE_LOG_TAIL_LINES,
    type DeadService,
    Inconclusive,
    type RunOutcome,
    type Runner,
    type RunSession,
    type RuntimeSample,
} from './runner.js';
import { applyCloseTimeReadout, dockerAdopt } from './docker-close-read.js';
import { armRunTimers } from './docker-run-timers.js';
import { createRunner } from './docker-create-runner.js';
import {
    ERROR_DETAIL_MAX_CHARS,
    assertJobNotKilled,
    dockerErrorDetail,
    dockerRunVerdict,
    CONTAINER_ID,
    DOCKER_NAME,
    LEASE_FORMAT,
    listOtherAttemptsOrThrow,
    readDocker,
    type ClosedState,
    removeEachTolerantly,
    run,
    restartJobServices,
    servicePsArgs,
    startJobServices,
    type RunnerFiles,
    attemptExec,
    type Spawn,
    type ExecDocker,
    readUtf8,
} from './docker-runner-support.js';
import { createDeadlineRegistry, type DeadlineRegistry } from './run-deadline.js';
import { settleEnd } from './termination.js';

/**
 * The docker executor's stateful `RunnerDeps` methods and `createDockerRunner` itself — the
 * per-attempt fences and teardowns, the spawn and event wiring. The daemon plumbing and per-step
 * helpers live in `docker-runner-support.ts`, the close-time reads in `docker-close-read.ts`.
 */

/** What this process remembers of an attempt's container group: the run it was created for. */
interface GroupState {
    startedAt: string;
    session: RunSession | null;
    /** Taken over from a lost driver (#829): this runner created none of it, and orders no `go`. */
    resumed?: boolean;
}

/** How long `finish` waits for the group's supervisor to exit by itself before it kills the group. */
const GROUP_END_WAIT_MS = 20_000;

/** Everything a docker-runner method needs: the daemon transport, the config, and the per-attempt kill set. */
interface RunnerDeps {
    config: DriverConfig;
    execDocker: ExecDocker;
    files: RunnerFiles;
    spawnFn: Spawn;
    /** Paces the adoption's discovery retries; a stand-down cuts it short. */
    sleep: Sleep;
    /** The supervised-step channel and the endpoint a supervisor-only group is served on (`step-control.ts`). */
    steps?: StepSink;
    endpoint?: SupervisorEndpoint;
    /** The attempt groups this runner created, by lease token: one per attempt, never shared. */
    groups: Map<string, GroupState>;
    /**
     * What this driver did to each attempt, by lease token: a kill() may have fired while that
     * attempt may still be awaiting the daemon in its services setup (`was(job).stopped`), or taken
     * its whole group down (`hard`, so the supervisor's exit is the kill's). Keyed by LEASE TOKEN,
     * not job id: the token is the per-attempt identity —
     * one driver process can hold two attempts of the same id at once (the poll loop re-claims an
     * expired-lease job while the first attempt's setup is still in flight), and the loop's kill
     * names the one attempt it killed. Keyed by id, the two attempts would share one marker: the
     * sibling claim would either be aborted by a kill meant for the other, or — wiping the marker
     * on entry, as this once did — revive the killed attempt to compete for the same network and
     * containers. Tokens never repeat, so the set only ever grows, by one entry per lost lease.
     *
     * This set is EFFICIENCY and early abort, not correctness: every daemon call any path issues
     * is scoped to its own attempt — by the lease label in its filters and the token in its
     * names — so a dying setup could issue every call it has and still never touch a sibling
     * attempt's resources. What the checks buy is that a dying setup stops CREATING: it does not
     * go on building a network, starting services and spawning a runner over a lease that is
     * already gone.
     */
    ledger: KillLedger;
    deadlines: DeadlineRegistry;
    /** Each adopting lease's adopted earlier lease (`dockerAdopt`): its fences keep that group (issue #821). */
    adopted: Map<BoardJob['leaseToken'], BoardJob['leaseToken']>;
}

/*
 * The re-claim fence — the only JOB-scoped sweep this runner performs, and the one component
 * allowed to be job-scoped: whatever it finds under ANOTHER lease is treated as a previous
 * attempt's leftover, and this attempt's own objects — its group, the services the loop started
 * before run() — are spared by the lease label. Names are attempt-scoped, so no name can find a
 * previous attempt's leftovers — the `factory.job` label is the one identifier every attempt of
 * the job shares, and the sweep is by label: every leftover container (runners, groups and
 * services alike), then every leftover volume. This claim exists only because those attempts'
 * leases are gone, so removing them delivers the same verdict their heartbeats would have, had
 * the driver survived to receive it — and the alternative to leaving a live leftover runner
 * running is two writers on one checkout, which is the thing actually worth preventing.
 *
 * It runs TWICE per attempt by design: once in syncCheckout — the loop calls the sync before
 * run(), and the sync is the first writer on the task worktree, so the previous attempt's runner
 * must be off the daemon before the worktree script starts, not only before the runner does — and
 * once in run(), which keeps its own call so the guarantee never depends on the loop's ordering.
 * The sweep is idempotent; removing twice what was removed once removes nothing.
 *
 * Failures PROPAGATE, and for one reason: a swallowed daemon refusal would be indistinguishable
 * from "nothing left", and the sync would start while the leftover runner still writes the
 * worktree. A refusal here is INFRASTRUCTURE — syncCheckout lets it throw (the loop leaves the
 * job to its lease), and run()'s own call propagates the same way — never the command's verdict.
 * The one tolerated shape is docker's already-gone answer on a removal: a container exiting
 * between the ps and its rm is the fence succeeding, not failing.
 */
async function dockerReclaimFence(deps: RunnerDeps, job: BoardJob, signal: AbortSignal): Promise<void> {
    // An adoption's fence stops at its attempt's stand-down: no call of it is made after (#824).
    const execDocker = attemptExec(deps.execDocker, signal);
    // The run this attempt adopted is kept, as kubernetes keeps its Job, for a later claim (issue #821).
    const kept = { leaseToken: job.leaseToken, spared: deps.adopted.get(job.leaseToken) };
    const containerIds = await listOtherAttemptsOrThrow(
        execDocker,
        ['ps', '-a', '--filter', `label=${JOB_LABEL}=${job.id}`, '--format', LEASE_FORMAT('ID')],
        `the re-claim fence could not list the leftover containers of job ${job.id}`,
        { ...kept, grammar: CONTAINER_ID }
    );
    await removeEachTolerantly(
        execDocker,
        containerIds,
        (id) => ['rm', '-f', id],
        (id) => `the re-claim fence could not remove the leftover container ${id} of job ${job.id}`
    );

    // The supervisor's mailboxes of those attempts, after their containers: transient control —
    // a Stop, an answer, a heartbeat — never finished work, which lives on the task volume.
    const staleVolumes = await listOtherAttemptsOrThrow(
        execDocker,
        ['volume', 'ls', '--filter', `label=${JOB_LABEL}=${job.id}`, '--format', LEASE_FORMAT('Name')],
        `the re-claim fence could not list the leftover control volumes of job ${job.id}`,
        { ...kept, grammar: DOCKER_NAME }
    );
    await removeEachTolerantly(
        execDocker,
        staleVolumes,
        (name) => ['volume', 'rm', '-f', name],
        (name) => `the re-claim fence could not remove the leftover control volume ${name} of job ${job.id}`
    );
}

/** The daemon seam of one attempt: ends with its kill and a deadline per command (#869). */
const attemptExecOf = (deps: RunnerDeps, job: BoardJob): ExecDocker =>
    attemptExec(deps.execDocker, deps.ledger.signal(job));

/** Waits for the supervisor of a started group to pull; a plain error at the bound, no proof of why. */
async function awaitGroupUp(deps: RunnerDeps, job: BoardJob): Promise<void> {
    const up = await awaitFirstContact(stepHostOf(deps), job, {
        sleep: deps.sleep,
        signal: deps.ledger.signal(job),
    });
    if (!up) {
        throw new Error(`the task supervisor ${supervisorName(job)} never came up within ${GROUP_UP_WAIT_MS}ms`);
    }
}

/**
 * Creates the attempt's container group once, under the re-claim fence: the supervisor, the
 * exporter and the mailboxes, started beside each other — the agent is created and started by
 * `run`, attached, after the supervisor releases it. The group is the attempt's, from its first
 * step (the sync) to its last, not the agent's: a second call (the run after the sync) finds it,
 * and refuses a run specced for another session than the group's. The group is not up until its
 * supervisor has pulled from the driver: a kill ends that wait at once, and a supervisor that
 * started and never answered is a plain error at the bound, left to the lease.
 */
async function ensureGroup(deps: RunnerDeps, job: BoardJob, session: RunSession | null): Promise<GroupState> {
    const known = deps.groups.get(job.leaseToken);
    if (known) {
        if (known.session?.id !== session?.id || known.session?.resume !== session?.resume) {
            throw new Error(`the task group of job ${job.id} was specced for another session than the run's`);
        }
        return known;
    }
    // A lease the ledger says was stopped gets no group: its kill is this attempt's, not an earlier
    // group's, and a step that awaited (a credential) must not revive the attempt it lost.
    assertJobNotKilled(deps.ledger, job);
    await dockerReclaimFence(deps, job, deps.ledger.signal(job));
    // A fresh supervisor answers the token from here: not one a kill already took away.
    attachSteps(stepHostOf(deps), job);
    const startedAt = new Date().toISOString();
    const execDocker = attemptExecOf(deps, job);
    try {
        await createGroup({ ...deps, execDocker, teardown: deps.execDocker }, job, session, { startedAt });
        await startGroup(execDocker, job, session);
    } catch (e) {
        await removeGroup(deps.execDocker, job);
        // A call the kill cut short is the kill's, not the daemon's refusal.
        assertJobNotKilled(deps.ledger, job);
        throw e;
    }
    try {
        await awaitGroupUp(deps, job);
    } catch (e) {
        await removeGroup(deps.execDocker, job);
        throw e;
    }
    const group: GroupState = { startedAt, session };
    deps.groups.set(job.leaseToken, group);
    return group;
}

/**
 * Ends the attempt's group by order, waits (bounded) for its supervisor to exit, and removes it —
 * every time: a group a kill already took out of `groups` was only stopped, and its supervisor,
 * exporter and mailboxes are still this attempt's to remove (issue #821). Never throws.
 */
async function finishGroup(deps: RunnerDeps, job: BoardJob): Promise<void> {
    if (deps.groups.delete(job.leaseToken)) {
        await orderFinish(stepHostOf(deps), job).catch(() => undefined);
        if ((await awaitSupervisor(deps.execDocker, job, GROUP_END_WAIT_MS)) === null) {
            await dockerKill(deps, job);
        }
    }
    // The exited runner container a run left, read for its verdict but kept as the adoption evidence.
    await deps.execDocker(['rm', '-f', containerName(job)]).catch(() => undefined);
    await removeGroup(deps.execDocker, job);
}

/*
 * The startup sync (or, for a claim that continues a session, the restore) as the attempt's first
 * supervised step. The fence BEFORE the sync: the sync is the first writer on the task worktree, so
 * a previous attempt's containers must be off the daemon before the worktree script starts. A
 * starting claim gets fetch + create-or-rebase; a continuing claim gets RESTORE=1 — no fetch, no
 * rebase, nothing that touches the remote (issue #58). A conflicting rebase aborts itself in the
 * script and answers { ok: false } with the reason — the loop fails the run before it starts
 * rather than leaving the worktree mid-rebase for every later turn to trip over.
 */
async function dockerSyncCheckout(
    deps: RunnerDeps,
    job: BoardJob,
    session: RunSession | null = null,
    githubToken?: string
): Promise<SyncResult> {
    const { config } = deps;
    if (!repoPath(config, job) || !worktreeDir(config, job)) return { ok: true, reason: null }; // nothing synced
    try {
        await ensureGroup(deps, job, session);
        return await runSyncStep(stepHostOf(deps), job, githubToken);
    } catch (e) {
        // A group that cannot exist, or a channel that closed under the sync, leaves nothing behind
        // and nothing to hand back: the loop leaves the job to its lease.
        await removeGroup(deps.execDocker, job);
        deps.groups.delete(job.leaseToken);
        throw e;
    }
}

/*
 * The terminal reclaim, in a supervisor-only group: the thread has no attempt, so there is no group
 * to ask. The group is a supervisor and nothing else under a lease of its own — it answers to
 * nothing of the thread's attempts. Removing the tree needs nothing the claim held, so no claim env
 * rides it. A job that names no repository never had a tree: "reclaimed, nothing was there".
 */
async function dockerReclaimWorktree(deps: RunnerDeps, job: BoardJob): Promise<ReclaimResult> {
    const { config } = deps;
    if (!repoPath(config, job) || !worktreeDir(config, job)) return { ok: true, removed: false, reason: null };
    if (!deps.endpoint) {
        return {
            ok: false,
            removed: false,
            reason: 'this driver has no supervisor endpoint to run the reclaim through',
        };
    }
    const opened = await deps.endpoint.open();
    // A supervisor alone (#773 D11): no agent, and no gate or service its checkout would bring.
    const group: BoardJob = {
        ...job,
        agent: false,
        gates: null,
        services: [],
        leaseToken: randomUUID(),
        supervisorEnv: { [SUPERVISOR_ENV.controlUrl]: opened.url, [SUPERVISOR_ENV.controlToken]: opened.token },
    };
    try {
        // Issue #814: the tool uid first gives back what it closed; the reclaim's verdict decides.
        const release = toolTreeReleaseArgs(config, job);
        if (release) await deps.execDocker(release, { timeout: RELEASE_DEADLINE_MS }).catch(() => undefined);
        await createGroup(deps, group, null, { startedAt: new Date().toISOString(), reclaim: job.leaseToken });
        await startGroup(deps.execDocker, group, null);
        await awaitGroupUp(deps, group);
        return await runReclaimStep(stepHostOf(deps), group);
    } catch (e) {
        return {
            ok: false,
            removed: false,
            reason: `the worktree reclaim group failed: ${dockerErrorDetail(e).slice(0, ERROR_DETAIL_MAX_CHARS)}`,
        };
    } finally {
        await orderFinish(stepHostOf(deps), group).catch(() => undefined);
        deps.endpoint.close(opened.token);
        await dockerKill(deps, group);
        await removeGroup(deps.execDocker, group);
    }
}

/**
 * The step host of an attempt whose first step is not its sync — an adopted run, whose agent
 * already ended under an earlier claim: a group is created for it on demand, a supervisor and no
 * agent, because the probe, the helpers and the publish are still its steps. A group the sync
 * already created is simply answered.
 */
async function stepHostFor(deps: RunnerDeps, job: BoardJob): Promise<StepHost> {
    if (!deps.groups.has(job.leaseToken)) await ensureGroup(deps, { ...job, agent: false }, null);
    return stepHostOf(deps);
}

/** The attempt's group as a gate run reaches it (`docker-gate.ts`). */
const gateDeps = (deps: RunnerDeps, job: BoardJob): DockerGateDeps => ({ host: () => stepHostFor(deps, job) });

/**
 * The declared services, in the network namespace of the attempt's group supervisor (issue #773):
 * the sync's group, or one made now for an attempt that synced none, before any service starts.
 */
async function dockerStartServices(deps: RunnerDeps, job: BoardJob, signal?: AbortSignal): Promise<RunOutcome | null> {
    if (groupServices(deps.config, job).length === 0) return null;
    await stepHostFor(deps, job);
    return startJobServices(
        job,
        deps.config,
        {
            ...deps,
            execDocker: attemptExec(deps.execDocker, anyOf(signal, deps.ledger.signal(job))),
            serviceTeardown: (j) => dockerServiceTeardown(deps, j),
        },
        signal
    );
}

// The container is named by this attempt's lease token, so a sample can only ever resolve
// its own attempt's runner — the same attempt-scoping every per-attempt operation here
// leans on. A refused read (the container exited between the ask and the stats round-trip,
// the daemon is busy) answers null, which the loop reads as "report no vitals this round".
// The service fleet is read in the same sampling round, scoped by the same label pair the
// teardown tears down with and requiring the `factory.service` key, so the runner and
// gate containers never answer it; a failed read costs the fleet, not the sample.
async function dockerSampleRuntime(deps: RunnerDeps, job: BoardJob): Promise<Omit<RuntimeSample, 'sampledAt'> | null> {
    const { config } = deps;
    const execDocker = attemptExecOf(deps, job);
    const read = await execDocker(['stats', '--no-stream', '--format', '{{json .}}', containerName(job)]).catch(
        () => null
    );
    const vitals = read ? parseDockerStats(read.stdout) : null;
    const services = config.servicesEnabled
        ? await execDocker(servicePsArgs(job))
              .then((found) => parseDockerServicePs(found.stdout))
              .catch(() => null)
        : undefined;
    return composeRuntimeSample(vitals, services);
}

/**
 * The attempt's dead services (issue #423) — `exited` or `dead` in the sample's own fleet read,
 * each inspected for how it ended and tailed for what it last printed, stderr included: an
 * entrypoint's refusal lands there. An unreadable fleet throws; an unreadable inspect or log
 * costs its detail, never the finding.
 */
async function dockerDeadServices(deps: RunnerDeps, job: BoardJob): Promise<DeadService[]> {
    const { config } = deps;
    const execDocker = attemptExecOf(deps, job);
    if (!config.servicesEnabled) return [];
    const found = await readDocker(execDocker, servicePsArgs(job), 'listing the attempt services', {
        parse: parseDockerServicePs,
    });
    if (found.kind !== 'value') throw new Inconclusive(found.kind === 'inconclusive' ? found.reason : 'absent');
    const listed = found.value;
    const out: DeadService[] = [];
    // A declared service with no container at all — removed by hand — is dead too: no exit or log to read.
    for (const gone of missingDeclaredServices(job, listed)) {
        out.push({ ...gone, exitCode: null, reason: 'container removed', logTail: '' });
    }
    for (const service of listed) {
        if (service.state !== 'exited' && service.state !== 'dead') continue;
        const name = serviceContainerName(job, service.name);
        const exit = await execDocker(['inspect', '--format', '{{json .State}}', name])
            .then((read) => parseDockerServiceExit(read.stdout))
            .catch(() => ({ exitCode: null, reason: null }));
        const logTail = await execDocker(['logs', '--tail', String(SERVICE_LOG_TAIL_LINES), name])
            .then((read) => `${read.stdout}${read.stderr ?? ''}`)
            .catch(() => '');
        out.push({ ...service, ...exit, logTail });
    }
    return out;
}

/** How long a taken-over run's exit is waited for once its log stream has closed. */
const RESUMED_EXIT_WAIT_MS = 30_000;

/**
 * The exit code of a taken-over runner container (#829), read with a bounded `docker wait` once its
 * followed log has closed — `docker logs -f` exits 0 whatever the container did. A stream that closed
 * with an error is no end of the run (the container may still run); a wait that cannot say rejects,
 * which the loop leaves to its lease. `wait` is the uncancelled daemon seam: a killed run's exit is still read.
 */
async function resumedExit(wait: ExecDocker, job: BoardJob, streamExit: number | null): Promise<number> {
    if (streamExit !== 0)
        throw new Error(`following the log of ${containerName(job)} ended with ${streamExit ?? 'a signal'}`);
    const waited = (await wait(['wait', containerName(job)], { timeout: RESUMED_EXIT_WAIT_MS })).stdout.trim();
    if (!/^-?\d+$/.test(waited)) throw new Inconclusive(`docker wait answered '${waited}'`);
    return Number(waited);
}

async function dockerRun(
    deps: RunnerDeps,
    job: BoardJob,
    session: RunSession | null,
    onOutput?: (tail: string) => void
): Promise<RunOutcome> {
    const { config, files, spawnFn, ledger } = deps;
    const execDocker = attemptExecOf(deps, job); // ends with the kill; the cleanup (`teardown`) does not
    const teardown = deps.execDocker;
    // No entry-time clearing of the killed set: a fresh claim carries a fresh lease
    // token that was never recorded, so nothing recorded for an earlier attempt can
    // reach this one — and clearing by id would revive exactly the dead attempt the
    // token keying exists to keep down. See RunnerDeps for the killed set's own comment.

    /*
     * The fence before anything this attempt creates — the job-scoped sweep documented
     * on dockerReclaimFence above — and the group it guards: the supervisor and the exporter, which
     * the sync already created when the loop synced first (`ensureGroup` finds them), or are
     * created here when no sync preceded the run. A group the daemon refuses is infrastructure,
     * thrown like a refused exporter was: never a run that silently loses its record.
     */
    // A group made fresh forgets the kill an earlier group of this attempt recorded, so a killed job is refused first.
    assertJobNotKilled(ledger, job);
    const { startedAt, resumed } = await ensureGroup(deps, job, session);

    /*
     * Auxiliary services (issue #6) were started by the loop (`startServices`) before the gate
     * environment and its setup, in the group supervisor's network namespace the runner joins too
     * (issue #773); the fence above spares them as this attempt's own. A kill that lands while an
     * await below is pending must stop the attempt: the check runs after the claim-env file write
     * and after the create/copy — the last awaits before the spawn — so the gap between that final
     * check and spawnFn is synchronous.
     */

    // A group taken over from a lost driver (#829) has its runner container up and released: nothing
    // is created, no env file written and no `go` ordered; the run attaches to the container's log.
    const created = resumed ? null : await createRunner(deps, attemptExecOf(deps, job), job, session);
    if (created?.refused) return created.refused;
    const file = created?.file ?? null;

    // The supervisor and the exporter were started with the group and outlive the agent: the agent
    // is released by the supervisor's `go` order, which also hands it what is left of the run
    // budget, and the supervisor reports once the agent is gone and its exporter drained.
    const host = stepHostOf(deps);
    const reported = host.sink.awaitReport(controlTokenOf(job)).catch(() => null);
    if (!resumed) {
        try {
            await orderGo(host, job);
        } catch (e) {
            await teardown(['rm', '-f', containerName(job)]).catch(() => undefined);
            if (file) await files.rm(file).catch(() => undefined);
            throw e;
        }
    }

    const outcome = new Promise<RunOutcome>((resolve, reject) => {
        // See dockerRunVerdict for what a close decides and why. Bound to this attempt's
        // own mutable state, read at call time (the close handler, well after all of it
        // has settled).
        const verdict = (code: number | null): Promise<RunOutcome> =>
            dockerRunVerdict(code, {
                execDocker,
                teardown,
                job,
                output,
                timedOut,
                cacheLost: cacheState.cacheLost,
                fullLog: fullLog.content,
                logTruncated: fullLog.truncated,
                closed: proven,
            });

        // A taken-over run is already up: its log is followed from the start, and its exit read after.
        // The followed log ends with the container, as `start -a` does: a Stop, a kill or the backstop end
        // the container, never the stream, so the verdict they decide is read as a started run's. Only an
        // abandonment hangs up on it (spawn terminates the child on abort).
        const child = spawnFn(
            'docker',
            resumed ? ['logs', '-f', containerName(job)] : ['start', '-a', containerName(job)],
            {
                stdio: ['ignore', 'pipe', 'pipe'],
                ...(resumed ? { signal: ledger.abandoned(job) } : {}),
            }
        );
        let timedOut = false;
        let proven: ClosedState | null = null;
        const cacheState: { cacheLost: string | null } = { cacheLost: null };

        let output = '';
        // The full-log accumulator (issue #325): everything the stream printed, tail-kept at
        // ARTIFACT_LIMIT bytes — the artifact the loop uploads at close, of which the rolling
        // tail above is only the end. Kept separately from `output`, whose window is the
        // report's, and grown by the same chunks.
        let fullLog: KeptLog = { content: '', truncated: false };
        const collect = (text: string) => {
            output += text;
            // Keep the tail: a run that fails says why at the end, and the head is banner.
            // Byte-true, because the report has to fit the board's body limit whatever the
            // log contained — see reportTail.
            output = reportTail(output);
            fullLog = appendTailKept(fullLog, text);
            // The same tail a complete report would carry, handed over as it grows. Every
            // chunk calls back; throttling is the loop's business, not this runner's.
            onOutput?.(output);
        };
        readUtf8(child.stdout, collect);
        readUtf8(child.stderr, collect);

        const done = armRunTimers(
            deps,
            { execDocker, config, job, backstopMs: agentBackstopMs(config, job, resumed ? spentMs(startedAt) : 0) },
            cacheState,
            {
                backstop: () => {
                    timedOut = true;
                    void dockerKillFor(deps, job, { reason: 'timeout', detail: '' });
                },
                cacheLost: (j) => dockerKillFor(deps, j, { reason: 'cache_lost', detail: cacheState.cacheLost ?? '' }),
            }
        );

        /*
         * A spawn failure makes Node deliver 'error' and then 'close' with a null code.
         * The flag keeps the two apart: once it is set, close must not settle the
         * promise, because verdict(null) would read as a started run with no exit code —
         * terminally reported as a failed job — when the truth is infrastructure the
         * loop should leave to its lease for retry.
         */
        let spawnFailed = false;
        child.on('error', (error) => {
            spawnFailed = true;
            done();
            // The spawn itself failed (docker missing, exec blew up): a fact, not a teardown. The
            // services and the group are the loop's end() to release or retain.
            reject(error);
        });
        child.on('close', (code) => {
            // The error handler owns this failure and rejects immediately; a close
            // here carries only the null code of a process that never ran, and settling
            // verdict(null) over the pending rejection would turn infrastructure into a
            // terminal verdict.
            if (spawnFailed) return;
            done();
            // Every close-time read this runner performs — opencode's session scrape,
            // then claude-code's agent-turn count — lives in applyCloseTimeReadout:
            // best-effort throughout, so a failed read costs the task its follow-ups or
            // its turn figure, never its verdict.
            // The agent's end does not end the run: the supervisor drains the exporter first and
            // reports — the budget it enforced says `timed_out` — and then serves the attempt's
            // steps. A supervisor that exited instead of reporting says how: 124 is the budget it
            // enforced, the driver's own hard kill explains its exit, and anything else is a
            // supervisor lost, an infrastructure loss (`settleEnd`).
            void (resumed ? resumedExit(teardown, job, code) : Promise.resolve(code))
                .then((exit) =>
                    closeEndOf(execDocker, job, { code: exit, output, reported }).then((ended) => ({ ended, exit }))
                )
                .then(({ ended, exit }) => {
                    proven = ended.proven;
                    // An exit with no report taken leaves nobody to answer the steps the loop still sends.
                    if (!ended.report) releaseSteps(host, job);
                    return { ...ended, exit };
                })
                .then(async ({ report, supervisorExit, exit: code }) => {
                    // The verdict read below reports the budget, so it is settled first.
                    if (report?.outcome === 'timed_out' || supervisorExit === SUPERVISOR_EXIT.deadline) {
                        timedOut = true;
                    }
                    const { infraLoss: vanished = null, ...settled } = await verdict(code);
                    const end = settleEnd({
                        kills: [],
                        driverKilledHard: deps.ledger.was(job).hard,
                        report,
                        budgetEnded: timedOut,
                        vanished,
                        unfinalized: supervisorLossOf(supervisorExit, false),
                    });
                    // A run the platform took away has nothing left to read: the loss, as kubernetes ends it.
                    if (end.infraLoss) {
                        const { exitCode, output, timedOut: lostTimedOut, started } = settled;
                        return { exitCode, output, timedOut: lostTimedOut, started, infraLoss: end.infraLoss };
                    }
                    return applyCloseTimeReadout(
                        settled,
                        { execDocker, config, job, startedAt, signal: deps.ledger.signal(job) },
                        session
                    );
                })
                .then(resolve, reject);
        });
    });

    // The file dies with the run — verdict read or not, resolved or thrown. The CLI has
    // long since read it; the daemon has the values in the container's config.
    try {
        return await outcome;
        // A throw is a fact: the loop's end() finishes the group or retains it for the next claim.
    } finally {
        if (file) await files.rm(file).catch(() => undefined);
        // A run that resolved leaves the group up — the gates, the helpers and the publish are its
        // steps, and the loop's `finish` ends it (its mailboxes with it: transient control, never
        // finished work, which lives on the task volume).
    }
}

/**
 * Builds the docker executor's runner: one instance per driver process, holding this attempt's
 * kill set across every method call. Each method below is a thin dispatch onto its standalone
 * `dockerX` function, over the shared `deps` — the split that keeps every one of them under the
 * function-length budget while still sharing the one piece of state (`killed`) that must survive
 * between calls.
 */
export function createDockerRunner(
    config: DriverConfig,
    spawnFn: Spawn = spawn,
    execDocker: ExecDocker = (args, { input, ...options } = {}) => {
        const pending = run('docker', args, { ...options, encoding: 'utf8' });
        // A CLI that exits before reading its stdin must not crash the driver with an EPIPE.
        pending.child.stdin?.on('error', () => undefined);
        if (input) pending.child.stdin?.end(input);
        return pending;
    },
    extras: { files?: RunnerFiles; steps?: StepSink; endpoint?: SupervisorEndpoint; sleep?: Sleep } = {}
): Runner {
    const deadlines = createDeadlineRegistry();
    const ledger = createKillLedger({
        write: (job, kill) => recordDockerKill(execDocker, job, kill),
    });
    const { files = { writeFile, rm }, steps, endpoint, sleep = abortableSleep } = extras;
    const deps: RunnerDeps = {
        config,
        execDocker,
        files,
        spawnFn,
        sleep,
        ledger,
        deadlines,
        groups: new Map(),
        adopted: new Map(),
        ...(steps ? { steps } : {}),
        ...(endpoint ? { endpoint } : {}),
    };
    return onOwnGroup({
        kill: (job) => dockerKill(deps, job),
        pauseDeadline: async (job, paused) => deadlines.pause(job.leaseToken, paused),
        releaseServices: (job) => dockerServiceTeardown(deps, job),
        syncCheckout: (job, _signal, session, githubToken) =>
            dockerSyncCheckout(deps, job, session ?? null, githubToken),
        finish: (job) => finishGroup(deps, job),
        reclaimWorktree: (job) => dockerReclaimWorktree(deps, job),
        ...supervisedStepMembers({
            host: stepHostOf(deps),
            hasGroup: (job) => deps.groups.has(job.leaseToken),
            createGroup: (job) => ensureGroup(deps, job, null),
            // A group the daemon refuses fails the helper in the daemon's own words, bounded.
            errorDetail: (e) => dockerErrorDetail(e).slice(0, ERROR_DETAIL_MAX_CHARS),
        }),
        runGate: (job, gate, signal) => runDockerGate(gateDeps(deps, job), job, gate, signal),
        resizeGate: async () => false, // no in-place resize: the gate container keeps its GATE_* sizing
        resizeReviewer: async () => false, // likewise the reviewer container: it keeps its RUNNER_* sizing
        runReview: (caller, review, session, control) =>
            runDockerReview(gateDeps(deps, caller), reviewRunOf(caller, review, session, control), control?.signal),
        rebind: (group, binding, signal) => rebindGroup(execDocker, group, binding, signal),
        abandon: (job) => ledger.abandon(job),
        sampleRuntime: (job) => dockerSampleRuntime(deps, job),
        deadServices: (job) => dockerDeadServices(deps, job),
        restartServices: (job, signal) => restartJobServices(job, execDocker, anyOf(signal, ledger.signal(job))),
        startServices: (job, signal) => dockerStartServices(deps, job, signal),
        run: (job, session, onOutput) => dockerRun(deps, job, session, onOutput),
        adopt: (job, signal) =>
            dockerAdopt({ ...deps, fence: (fenced, stand) => dockerReclaimFence(deps, fenced, stand) }, job, signal),
        stopAgent: (job) => dockerStopAgent(deps, job),
        recordKill: (job, kill) => ledger.record(job, kill),
    });
}
