import { JOB_LABEL } from './labels.js';
import { awaitSupervisor, createGroup, removeGroup, startGroup, supervisorLossOf } from './docker-group.js';
import {
    dockerKill,
    dockerKillFor,
    dockerServiceTeardown,
    dockerStopAgent,
    recordDockerKill,
} from './docker-teardown.js';
import { SUPERVISOR_ENV, SUPERVISOR_EXIT, type SupervisorReport } from './supervisor-contract.js';
import { agentBackstopMs } from './supervisor-plan.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import type { BoardJob } from './board.js';
import type { DriverConfig } from './config.js';
import type { HelperCall, HelperPlan, HelperResult } from './helpers.js';
import { lookupHelper } from './helpers.js';
import { noStepChannel, type StepSink, type SupervisorEndpoint, stepLost } from './step-control.js';
import {
    attachSteps,
    controlTokenOf,
    orderFinish,
    orderGo,
    releaseSteps,
    runHelperStep,
    runReclaimStep,
    runSyncStep,
    type StepHost,
    supervisedStepRunner,
} from './supervised-steps.js';
import {
    probeTreeFingerprint,
    publishCheckout,
    RELEASE_DEADLINE_MS,
    type PublishOptions,
    type PublishResult,
    repoPath,
    worktreeDir,
    type ReclaimResult,
    type SyncResult,
} from './publish.js';
import { missingDeclaredServices, serviceContainerName } from './services.js';
import {
    containerName,
    envFilePath,
    parseDockerServiceExit,
    parseDockerServicePs,
    parseDockerStats,
    toolTreeReleaseArgs,
} from './docker.js';
import { envFileBody } from './claim.js';
import { snapshotTree } from './review-snapshot.js';
import {
    appendTailKept,
    composeRuntimeSample,
    type KeptLog,
    reportTail,
    SERVICE_LOG_TAIL_LINES,
    type DeadService,
    type RunOutcome,
    type Runner,
    type RunSession,
    type RuntimeSample,
} from './runner.js';
import { applyCloseTimeReadout, dockerAdopt, tickCacheWatch } from './docker-close-read.js';
import {
    ERROR_DETAIL_MAX_CHARS,
    assertJobNotKilled,
    assertNotKilledAfterEnvWrite,
    createRunnerContainer,
    dockerErrorDetail,
    dockerRunVerdict,
    LEASE_FORMAT,
    listOtherAttemptsOrThrow,
    servicesNetworkOf,
    removeEachTolerantly,
    run,
    restartJobServices,
    servicePsArgs,
    startJobServices,
    type RunnerFiles,
    type Spawn,
    type ExecDocker,
    readUtf8,
} from './docker-runner-support.js';
import { OPENCODE } from './executors.js';
import { createDeadlineRegistry, type DeadlineRegistry } from './run-deadline.js';
import { infraLossOf } from './termination.js';

/**
 * The docker executor's stateful `RunnerDeps` methods and `createDockerRunner` itself — the
 * per-attempt fences and teardowns, the spawn and event wiring. The daemon plumbing and per-step
 * helpers live in `docker-runner-support.ts`, the close-time reads in `docker-close-read.ts`.
 */

/** What this process remembers of an attempt's container group: the run it was created for. */
interface GroupState {
    startedAt: string;
    session: RunSession | null;
}

/** How long `finish` waits for the group's supervisor to exit by itself before it kills the group. */
const GROUP_END_WAIT_MS = 20_000;

/** Everything a docker-runner method needs: the daemon transport, the config, and the per-attempt kill set. */
interface RunnerDeps {
    config: DriverConfig;
    execDocker: ExecDocker;
    files: RunnerFiles;
    spawnFn: Spawn;
    /** The supervised-step channel and the endpoint a supervisor-only group is served on (`step-control.ts`). */
    steps?: StepSink;
    endpoint?: SupervisorEndpoint;
    /** The attempt groups this runner created, by lease token: one per attempt, never shared. */
    groups: Map<string, GroupState>;
    /**
     * Lease tokens whose kill() fired while that attempt may still be awaiting the daemon in its
     * services setup. Keyed by LEASE TOKEN, not job id: the token is the per-attempt identity —
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
    killed: Set<BoardJob['leaseToken']>;
    /** The attempts whose whole group `dockerKill` took down (`TeardownDeps.hardKilled`). */
    hardKilled: Set<BoardJob['leaseToken']>;
    deadlines: DeadlineRegistry;
}

/*
 * The re-claim fence — the only JOB-scoped sweep this runner performs, and the one component
 * allowed to be job-scoped: whatever it finds under ANOTHER lease is treated as a previous
 * attempt's leftover, and this attempt's own objects — the services the loop started before run(),
 * a gate environment this attempt created — are spared by the lease label. A warm gate environment
 * an EARLIER attempt created carries that attempt's lease, so it is still swept here. Names are attempt-scoped now, so no name can
 * find a previous attempt's leftovers — the `factory.job` label is the one identifier every
 * attempt of the job shares, and the sweep is by label: every leftover container (runners and
 * services alike), then every leftover network. This claim exists only because those attempts'
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
 * between the ps and its rm is the fence succeeding, not failing. The transitional
 * unlabelled-network rm below keeps tolerating absent outright — it removes by a NAME that may
 * never have existed.
 */
async function dockerReclaimFence(deps: RunnerDeps, job: BoardJob): Promise<void> {
    const containerIds = await listOtherAttemptsOrThrow(
        deps.execDocker,
        ['ps', '-a', '--filter', `label=${JOB_LABEL}=${job.id}`, '--format', LEASE_FORMAT('ID')],
        `the re-claim fence could not list the leftover containers of job ${job.id}`,
        job
    );
    await removeEachTolerantly(
        deps.execDocker,
        containerIds,
        (id) => ['rm', '-f', id],
        (id) => `the re-claim fence could not remove the leftover container ${id} of job ${job.id}`
    );

    const staleNetworks = await listOtherAttemptsOrThrow(
        deps.execDocker,
        ['network', 'ls', '--filter', `label=${JOB_LABEL}=${job.id}`, '--format', LEASE_FORMAT('Name')],
        `the re-claim fence could not list the leftover networks of job ${job.id}`,
        job
    );
    await removeEachTolerantly(
        deps.execDocker,
        staleNetworks,
        (name) => ['network', 'rm', name],
        (name) => `the re-claim fence could not remove the leftover network ${name} of job ${job.id}`
    );

    // The supervisor's mailboxes of those attempts, after their containers: transient control —
    // a Stop, an answer, a heartbeat — never finished work, which lives on the task volume.
    const staleVolumes = await listOtherAttemptsOrThrow(
        deps.execDocker,
        ['volume', 'ls', '--filter', `label=${JOB_LABEL}=${job.id}`, '--format', LEASE_FORMAT('Name')],
        `the re-claim fence could not list the leftover control volumes of job ${job.id}`,
        job
    );
    await removeEachTolerantly(
        deps.execDocker,
        staleVolumes,
        (name) => ['volume', 'rm', '-f', name],
        (name) => `the re-claim fence could not remove the leftover control volume ${name} of job ${job.id}`
    );

    // TRANSITIONAL: networks created before the lease token joined the name carry no
    // labels at all, so the sweep above cannot see them. Remove the pre-redesign name
    // outright; tolerated absent. This line may be dropped once no pre-redesign leftover
    // can exist any more.
    await deps.execDocker(['network', 'rm', `factory-job-${job.id}-services`]).catch(() => undefined);
}

/** The step host of this runner: the channel its supervisor serves, or a refusal naming the missing one. */
const stepHostOf = (deps: RunnerDeps): StepHost => ({ config: deps.config, sink: deps.steps ?? noStepChannel });

/**
 * Creates the attempt's container group once, under the re-claim fence: the supervisor, the
 * exporter and the mailboxes, started beside each other — the agent is created and started by
 * `run`, attached, after the supervisor releases it. The group is the attempt's, from its first
 * step (the sync) to its last, not the agent's: a second call (the run after the sync) finds it.
 */
async function ensureGroup(deps: RunnerDeps, job: BoardJob, session: RunSession | null): Promise<GroupState> {
    const known = deps.groups.get(job.leaseToken);
    if (known) return known;
    await dockerReclaimFence(deps, job);
    // A fresh supervisor answers the token from here: not one a kill already took away.
    attachSteps(stepHostOf(deps), job);
    const startedAt = new Date().toISOString();
    await createGroup(deps, job, session, { startedAt });
    try {
        await startGroup(deps.execDocker, job, session);
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
    const group: BoardJob = {
        ...job,
        agent: false,
        leaseToken: randomUUID(),
        supervisorEnv: { [SUPERVISOR_ENV.controlUrl]: opened.url, [SUPERVISOR_ENV.controlToken]: opened.token },
    };
    try {
        // Issue #814: the tool uid first gives back what it closed; the reclaim's verdict decides.
        const release = toolTreeReleaseArgs(config, job);
        if (release) await deps.execDocker(release, { timeout: RELEASE_DEADLINE_MS }).catch(() => undefined);
        await createGroup(deps, group, null, { startedAt: new Date().toISOString(), reclaim: true });
        await startGroup(deps.execDocker, group, null);
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

/**
 * One allowlisted helper step. An unknown helper id creates nothing (`runHelperStep` refuses it
 * first), and a group the daemon refuses is a failed helper; only a lost supervisor (`stepLost`)
 * is thrown.
 */
async function dockerRunHelper(
    deps: RunnerDeps,
    job: BoardJob,
    plan: HelperPlan,
    call: HelperCall
): Promise<HelperResult> {
    if (!lookupHelper(plan.helperId)) return runHelperStep(stepHostOf(deps), job, plan, call);
    try {
        return await runHelperStep(await stepHostFor(deps, job), job, plan, call);
    } catch (e) {
        if (stepLost(e)) throw e;
        return { ok: false, reason: 'runner_error', message: dockerErrorDetail(e).slice(0, ERROR_DETAIL_MAX_CHARS) };
    }
}

/** The publish: the one workflow both executors run, over the task supervisor's steps. */
async function dockerPublishGit(
    deps: RunnerDeps,
    job: BoardJob,
    githubToken?: string,
    options?: PublishOptions
): Promise<PublishResult> {
    const host = await stepHostFor(deps, job);
    return publishCheckout(
        deps.config,
        job,
        options,
        supervisedStepRunner(host, job, { kind: 'publish', githubToken })
    );
}

/** The probe and the review snapshot: the steps that read the task worktree, over the supervisor. */
const dockerTreeSteps = (deps: RunnerDeps): Pick<Runner, 'probeTree' | 'snapshotTree'> => ({
    probeTree: async (job, signal) =>
        probeTreeFingerprint(
            deps.config,
            job,
            supervisedStepRunner(await stepHostFor(deps, job), job, { kind: 'probe', signal })
        ),
    snapshotTree: async (job, key, signal) =>
        snapshotTree(
            deps.config,
            job,
            key,
            supervisedStepRunner(await stepHostFor(deps, job), job, { kind: 'snapshot', signal })
        ),
});

// The container is named by this attempt's lease token, so a sample can only ever resolve
// its own attempt's runner — the same attempt-scoping every per-attempt operation here
// leans on. A refused read (the container exited between the ask and the stats round-trip,
// the daemon is busy) answers null, which the loop reads as "report no vitals this round".
// The service fleet is read in the same sampling round, scoped by the same label pair the
// teardown tears down with and requiring the `factory.service` key, so the runner and
// gate containers never answer it; a failed read costs the fleet, not the sample.
async function dockerSampleRuntime(deps: RunnerDeps, job: BoardJob): Promise<Omit<RuntimeSample, 'sampledAt'> | null> {
    const { config, execDocker } = deps;
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
    const { config, execDocker } = deps;
    if (!config.servicesEnabled) return [];
    const found = await execDocker(servicePsArgs(job));
    const out: DeadService[] = [];
    const listed = parseDockerServicePs(found.stdout);
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

async function dockerRun(
    deps: RunnerDeps,
    job: BoardJob,
    session: RunSession | null,
    onOutput?: (tail: string) => void
): Promise<RunOutcome> {
    const { config, execDocker, files, spawnFn, killed } = deps;
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
    const { startedAt } = await ensureGroup(deps, job, session);

    /*
     * Auxiliary services (issue #6) were started by the loop (`startServices`) before the gate
     * environment and its setup; the fence above spares them as this attempt's own, and the
     * runner joins their network. A kill that lands while an await below is pending must stop
     * the attempt: the check runs after the claim-env file write and after the create/copy — the
     * last awaits before the spawn — so the gap between that final check and spawnFn is synchronous.
     */
    const servicesNetwork = servicesNetworkOf(job);

    // The runner container is the last resource this attempt creates, and the spawn is
    // what a killed setup must never reach — see assertJobNotKilled for why a throw is
    // the right verdict here.
    assertJobNotKilled(killed, job);

    /*
     * The env file's ride: a 0600 file in the OS temp directory, written just before the spawn
     * and removed as soon as the run is over — a crash leaves it in tmpdir at worst, never
     * in argv and never in this process's environment. The body is the claim env PLUS the
     * loop's minted gate credentials PLUS the runner's own attempt pair, so a gated job whose
     * claim resolves to nothing still carries its BELLOWS_GATE_URL/TOKEN and the credential
     * its attribution reports authenticate with.
     */
    const body = envFileBody(job, config);
    const file = body ? envFilePath(job) : null;
    if (file) await files.writeFile(file, body, { mode: 0o600 });
    // The write above is an await, so the kill-check must run once more: see
    // assertNotKilledAfterEnvWrite for why a lease lost while it was pending must not
    // reach spawnFn.
    await assertNotKilledAfterEnvWrite({ killed, job, files }, file);

    // The run's start instant (the group's, which the exporter and both close-time turn reads key
    // on): a follow-up resumes its session's conversation, so the delta each read reports is
    // bounded to what THIS run wrote.
    const refused = await createRunnerContainer(deps, job, session, {
        servicesNetwork,
        ...(file ? { envFile: file } : {}),
    });
    if (refused) {
        if (file) await files.rm(file).catch(() => undefined);
        await finishGroup(deps, job);
        return refused;
    }
    // The create and the copy are awaits too: a lease lost behind them must not reach the start.
    // The created container is this attempt's leftover to remove, the group and the env file with it.
    if (killed.has(job.leaseToken)) {
        await execDocker(['rm', '-f', containerName(job)]).catch(() => undefined);
        await removeGroup(execDocker, job);
        deps.groups.delete(job.leaseToken);
        await assertNotKilledAfterEnvWrite({ killed, job, files }, file);
    }

    // The supervisor and the exporter were started with the group and outlive the agent: the agent
    // is released by the supervisor's `go` order, which also hands it what is left of the run
    // budget, and the supervisor reports once the agent is gone and its exporter drained.
    const host = stepHostOf(deps);
    const reported = host.sink.awaitReport(controlTokenOf(job)).catch(() => null);
    try {
        await orderGo(host, job);
    } catch (e) {
        await execDocker(['rm', '-f', containerName(job)]).catch(() => undefined);
        if (file) await files.rm(file).catch(() => undefined);
        throw e;
    }

    const outcome = new Promise<RunOutcome>((resolve, reject) => {
        // See dockerRunVerdict for what a close decides and why. Bound to this attempt's
        // own mutable state, read at call time (the close handler, well after all of it
        // has settled).
        const verdict = (code: number | null): Promise<RunOutcome> =>
            dockerRunVerdict(code, {
                execDocker,
                job,
                output,
                timedOut,
                cacheLost: cacheState.cacheLost,
                fullLog: fullLog.content,
                logTruncated: fullLog.truncated,
            });

        const child = spawnFn('docker', ['start', '-a', containerName(job)], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let timedOut = false;
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

        // The BACKSTOP: the supervisor ends the agent at the run budget itself (its exit 124), so
        // this only fires for a group whose supervisor stopped doing that — the budget plus the
        // wind-down — and then kills all of it.
        const deadline = deps.deadlines.start(job.leaseToken, agentBackstopMs(config, job), () => {
            timedOut = true;
            void dockerKillFor(deps, job, { reason: 'timeout', detail: '' });
        });

        /*
         * The cache watch polls on a period while the run is live. Each tick is one
         * throwaway probe container; a probe that fails once (the daemon is busy, the
         * session is not there yet) just waits for the next tick, and the trigger itself
         * needs three consecutive damning turns, so no single answer — or no single fluke —
         * kills anything. The kill is this attempt's own, label-scoped like every other;
         * the task-type check below keeps it on opencode, and config keeps it docker-only.
         */
        let cacheTimer: NodeJS.Timeout | null = null;
        if (config.cacheWatch && job.executorType === OPENCODE) {
            cacheTimer = setInterval(() => {
                const kill = (j: BoardJob) =>
                    dockerKillFor(deps, j, { reason: 'cache_lost', detail: cacheState.cacheLost ?? '' });
                void tickCacheWatch({ execDocker, config, job, kill }, cacheState);
            }, config.cacheWatchPollMs);
        }

        const done = () => {
            deadline.clear();
            if (cacheTimer) clearInterval(cacheTimer);
        };

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
            // The spawn itself failed (docker missing, exec blew up). Whatever services
            // were started before it are torn down BEFORE the rejection lands — teardown
            // tolerates absence, so either way a rejection means cleanup is as done as
            // it gets, and the rejection waits for the teardown's verdict. The teardown
            // is attempt-scoped, so no supersession check is needed: even if a
            // replacement claim landed while this attempt was failing, the filters carry
            // this attempt's lease and the network is named after it — the teardown
            // cannot reach the replacement's fleet.
            Promise.all([dockerServiceTeardown(deps, job), removeGroup(execDocker, job)]).then(
                () => reject(error),
                () => reject(error)
            );
        });
        child.on('close', (code) => {
            // The error handler owns this failure and its rejection is already deferred
            // behind the service teardown; a close here carries only the null code of a
            // process that never ran, and settling verdict(null) over the pending
            // rejection would turn infrastructure into a terminal verdict.
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
            // supervisor lost, an infrastructure loss (`infraLossOf`).
            void awaitReportOrExit(execDocker, job, reported)
                .then((ended) => {
                    // An exit with no report taken leaves nobody to answer the steps the loop still sends.
                    if (!ended.report) releaseSteps(host, job);
                    return ended;
                })
                .then(async ({ report, supervisorExit }) => {
                    if (report?.outcome === 'timed_out' || supervisorExit === SUPERVISOR_EXIT.deadline) {
                        timedOut = true;
                    }
                    const { infraLoss: vanished = null, ...settled } = await verdict(code);
                    const infraLoss = infraLossOf({
                        killedByDriver: deps.hardKilled.has(job.leaseToken),
                        timedOut,
                        reported: report !== null,
                        vanished,
                        unfinalized: supervisorLossOf(supervisorExit, timedOut),
                    });
                    return infraLoss ? { ...settled, infraLoss } : settled;
                })
                .then((outcome) => applyCloseTimeReadout(outcome, { execDocker, config, job, startedAt }, session))
                .then(resolve, reject);
        });
    });

    // The file dies with the run — verdict read or not, resolved or thrown. The CLI has
    // long since read it; the daemon has the values in the container's config.
    try {
        return await outcome;
    } catch (e) {
        // The run threw: nothing more will be asked of the group, and no loop step is owed it.
        await finishGroup(deps, job);
        throw e;
    } finally {
        if (file) await files.rm(file).catch(() => undefined);
        // A run that resolved leaves the group up — the gates, the helpers and the publish are its
        // steps, and the loop's `finish` ends it (its mailboxes with it: transient control, never
        // finished work, which lives on the task volume).
    }
}

/**
 * Waits for the supervisor's report that the agent is over and its exporter drained, or for the
 * supervisor to exit without one (a kill, the budget — both end it at once — or a crash), whichever
 * comes first, bounded by the wind-down. The report's absence with no exit is reported as neither.
 */
async function awaitReportOrExit(
    execDocker: ExecDocker,
    job: BoardJob,
    reported: Promise<SupervisorReport | null>
): Promise<{ report: SupervisorReport | null; supervisorExit: number | null }> {
    const exited = awaitSupervisor(execDocker, job).then((supervisorExit) => ({ report: null, supervisorExit }));
    const answered = reported.then((report) =>
        report ? { report, supervisorExit: null } : new Promise<never>(() => undefined)
    );
    return Promise.race([answered, exited]);
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
    extras: { files?: RunnerFiles; steps?: StepSink; endpoint?: SupervisorEndpoint } = {}
): Runner {
    const deadlines = createDeadlineRegistry();
    const { files = { writeFile, rm }, steps, endpoint } = extras;
    const deps: RunnerDeps = {
        config,
        execDocker,
        files,
        spawnFn,
        killed: new Set(),
        hardKilled: new Set(),
        deadlines,
        groups: new Map(),
        ...(steps ? { steps } : {}),
        ...(endpoint ? { endpoint } : {}),
    };
    return {
        kill: (job) => dockerKill(deps, job),
        pauseDeadline: async (job, paused) => deadlines.pause(job.leaseToken, paused),
        releaseServices: (job) => dockerServiceTeardown(deps, job),
        syncCheckout: (job, _signal, session, githubToken) =>
            dockerSyncCheckout(deps, job, session ?? null, githubToken),
        finish: (job) => finishGroup(deps, job),
        reclaimWorktree: (job) => dockerReclaimWorktree(deps, job),
        publishGit: (job, githubToken, options) => dockerPublishGit(deps, job, githubToken, options),
        // The probe and the review snapshot need no claim env; like every step they run in the
        // supervisor, and a stand-down ends the wait for the answer, never the supervisor.
        ...dockerTreeSteps(deps),
        runHelper: (job, plan, call = {}) => dockerRunHelper(deps, job, plan, call),
        sampleRuntime: (job) => dockerSampleRuntime(deps, job),
        deadServices: (job) => dockerDeadServices(deps, job),
        restartServices: (job, signal) => restartJobServices(job, execDocker, signal),
        startServices: (job, signal) =>
            startJobServices(job, config, { ...deps, serviceTeardown: (j) => dockerServiceTeardown(deps, j) }, signal),
        run: (job, session, onOutput) => dockerRun(deps, job, session, onOutput),
        adopt: (job) => dockerAdopt({ ...deps, fence: (fenced) => dockerReclaimFence(deps, fenced) }, job),
        stopAgent: (job) => dockerStopAgent(deps, job),
        recordKill: (job, kill) => recordDockerKill(execDocker, job, kill),
    };
}
