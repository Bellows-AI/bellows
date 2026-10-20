import { createHash, randomUUID } from 'node:crypto';
import type { BoardJob } from './board.js';
import { claimEnv, claimContinuesSession, runTimeoutMs } from './claim.js';
import type { DriverConfig } from './config.js';
import { serviceRestartArgv } from './container-scripts.js';
import { withHelperReceipt } from './helper-receipts.js';
import {
    HELPER_TIMEOUT_MS,
    type HelperCall,
    type HelperDescriptor,
    type HelperPlan,
    type HelperResult,
    helperInputValue,
    lookupHelper,
    parseHelperOutput,
} from './helpers.js';
import { parseLastJsonLine } from './json-parse.js';
import { type Bound, pollFor, type Sleep, timeLeft } from './poll.js';
import {
    baseBranchOf,
    CREDENTIAL_HELPER,
    gitWorktreeRemoveScript,
    gitWorktreeScript,
    probeTreeFingerprint,
    publishCheckout,
    type PublishStep,
    type ReclaimResult,
    reclaimUnreadable,
    repoPath,
    reviewRootsDir,
    type RunPublishStep,
    SYNC_DEADLINE_MS,
    type SyncResult,
    syncUnreadable,
    worktreeBranch,
    worktreeDir,
} from './publish.js';
import { snapshotTree } from './review-snapshot.js';
import type { Runner } from './runner.js';
import { noStepChannel, StepTimedOut, type StepSink, stepLost } from './step-control.js';
import { SUPERVISOR_ENV, type StepKind, type StepRequest, type StepResult } from './supervisor-contract.js';

/**
 * The executor-neutral half of the supervised steps (issue #771): what the startup sync, the
 * terminal reclaim, the tree probe, the review snapshot, the publish steps and the allowlisted
 * helpers ask of an attempt's task supervisor, and how its answers read. Both executors hand the
 * same requests to the same channel (`step-control.ts`); the supervisor (`scripts/supervisor.cjs`)
 * runs each as a child process of its own container, in the executor image, over the task volume it
 * mounts. Nothing here creates a Job or a container.
 *
 * Credentials ride the step and nothing else: the claim env (and the board's GitHub token) is the
 * step's own environment, delivered to the supervisor over its authenticated control channel — the
 * agent container has no route to it and its spec names no such value.
 */

/** What a runner needs to submit steps: its config and the broker the control channel serves. */
export interface StepHost {
    config: DriverConfig;
    sink: StepSink;
}

/** The step host of a runner: the channel its supervisor serves, or a refusal naming the missing one. */
export const stepHostOf = (deps: { config: DriverConfig; steps?: StepSink }): StepHost => ({
    config: deps.config,
    sink: deps.steps ?? noStepChannel,
});

/** One publish step's own bound, the kubelet deadline the aux Jobs carried. */
const PUBLISH_STEP_TIMEOUT_MS = 600_000;
/** The terminal reclaim's bound. */
const RECLAIM_TIMEOUT_MS = 600_000;
/** The supervisor's own orders answer at once; this only bounds a supervisor that is not there. */
const ORDER_TIMEOUT_MS = 60_000;
/** How often an unanswered step is asked again under the same identity before the answer counts lost. */
const SUBMIT_ATTEMPTS = 3;
const ID_HASH_CHARS = 16;

const hash16 = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, ID_HASH_CHARS);

/** The attempt, as a step id's scope: job and lease, so a step of a superseded attempt never names a live one. */
const attemptKey = (job: BoardJob): string => hash16(`${job.id}|${job.leaseToken}`);

/** The supervisor's control token for the attempt: its channel's key, held by no other container. */
export function controlTokenOf(job: BoardJob): string {
    const token = job.supervisorEnv?.[SUPERVISOR_ENV.controlToken];
    if (!token) throw new Error(`job ${job.id} has no supervisor control channel: no run-control endpoint was opened`);
    return token;
}

/**
 * The claim env as a step's environment, with the board's GitHub token for this step laid over it
 * as `GITHUB_TOKEN` when the loop got one (docs/connections.md). The claim env itself never carries
 * one: the name is reserved, so `claimEnv` drops any a board sent.
 */
const claimStepEnv = (job: BoardJob, githubToken?: string): Record<string, string> => ({
    ...claimEnv(job),
    ...(githubToken ? { GITHUB_TOKEN: githubToken } : {}),
});

const slug = (label: string): string => label.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** The group serving the attempt ended or was taken away: its waiting and later steps fail at once. */
export function releaseSteps(host: Pick<StepHost, 'sink'>, job: BoardJob): void {
    const token = job.supervisorEnv?.[SUPERVISOR_ENV.controlToken];
    if (token) host.sink.release(token);
}

/** A group is being made for the attempt: its supervisor starts with no contact, report or refusal. */
export function attachSteps(host: Pick<StepHost, 'sink'>, job: BoardJob): void {
    const token = job.supervisorEnv?.[SUPERVISOR_ENV.controlToken];
    if (token) host.sink.attach(token);
}

/** How long a created group may take to show its supervisor — an image pull, a node scaling up. */
export const GROUP_UP_WAIT_MS = 600_000;
/** How often the wait for a group's first contact looks again. */
export const GROUP_UP_POLL_MS = 2_000;

/**
 * Waits until the attempt's supervisor has pulled from the driver at least once, on either executor.
 * Bounded by elapsed time, probe time included, not a count of polls; false at the bound, which is
 * the caller's to classify. A driver kill (an aborted `signal`) ends the wait at once and wins over everything
 * else: over a contact, over the bound, and over whatever the `probe` threw.
 */
export async function awaitFirstContact(
    host: Pick<StepHost, 'sink'>,
    job: BoardJob,
    opts: { sleep: Sleep; signal: AbortSignal; probe?: (bound: Bound) => Promise<void> }
): Promise<boolean> {
    const token = job.supervisorEnv?.[SUPERVISOR_ENV.controlToken];
    if (!token) return true;
    const killed = (): Error => new Error(`job ${job.id}: killed while its task group came up`);
    const { signal } = opts;
    const found = await pollFor(
        { ms: GROUP_UP_WAIT_MS, everyMs: GROUP_UP_POLL_MS, sleep: opts.sleep, signal, abandoned: killed },
        async (deadline) => {
            if (signal.aborted) throw killed();
            if (host.sink.contacted(token)) return true;
            try {
                await opts.probe?.({ deadline, signal });
            } catch (e) {
                if (signal.aborted) throw killed();
                throw e;
            }
            if (signal.aborted) throw killed();
        }
    );
    if (signal.aborted) throw killed();
    return found ?? false;
}

/**
 * Submits one step — one call — and answers its result. An unanswered call — its answer lost, the
 * supervisor slow — is delivered again as the SAME call (same id, same invocation): the supervisor
 * answers it from its ledger instead of running it twice. A closed channel (the attempt is gone)
 * and every other failure propagate; none of them is a verdict on the step.
 */
export async function submitStep(
    host: Pick<StepHost, 'sink'>,
    job: BoardJob,
    step: StepRequest,
    signal?: AbortSignal
): Promise<StepResult> {
    const token = controlTokenOf(job);
    for (let attempt = 1; ; attempt += 1) {
        try {
            return await host.sink.submit(token, step, signal);
        } catch (error) {
            if (!(error instanceof StepTimedOut) || attempt >= SUBMIT_ATTEMPTS || signal?.aborted) throw error;
        }
    }
}

/** What a failed step says, in the tool's own words: the stderr and stdout, else the exit. */
export const detailOf = (result: StepResult, timeoutMs: number): string => {
    if (result.timedOut) return `the step exceeded its ${timeoutMs}ms deadline`;
    return (
        `${result.stderr}${result.stdout}`.trim() || `the step exited ${result.exitCode ?? 'without a readable code'}`
    );
};

export const stepRequest = (
    job: BoardJob,
    kind: StepKind,
    parts: { id: string; argv?: string[]; cwd?: string | null; env?: Record<string, string>; timeoutMs: number }
): StepRequest => ({
    id: `${kind}-${attemptKey(job)}-${parts.id}`,
    // One call: the deliveries `submitStep` makes of this request share it, and nothing else does.
    invocation: randomUUID(),
    kind,
    argv: parts.argv ?? [],
    ...(parts.cwd ? { cwd: parts.cwd } : {}),
    env: parts.env ?? {},
    timeoutMs: parts.timeoutMs,
});

/**
 * The publish-shaped steps (publish, tree probe, review snapshot) as a `RunPublishStep` over the
 * supervisor: the workflows in `publish.ts` and `review-snapshot.ts` decide WHAT runs; this is
 * their transport. A step carrying a publication operation (`PublishStep.op`) has an identity
 * derived from it — a push that landed is answered, not rerun, however often it is asked — and
 * every other step gets a fresh one, since a probe must read the tree as it is now. Each call is a
 * new invocation: a caller that asks the same push again (the stale-lease recovery, after it
 * refreshed the remote) runs it unless it landed. A helper's receipt steps (`helper-receipts.ts`)
 * ride it as `helper` steps.
 */
export function supervisedStepRunner(
    host: StepHost,
    job: BoardJob,
    options: {
        kind: 'publish' | 'probe' | 'snapshot' | 'helper';
        githubToken?: string | undefined;
        signal?: AbortSignal | undefined;
    }
): RunPublishStep {
    const repo = worktreeDir(host.config, job);
    const nonce = randomUUID().slice(0, ID_HASH_CHARS);
    let counter = 0;
    return async (publish: PublishStep) => {
        counter += 1;
        const id = publish.op ? `${hash16(publish.op)}-${slug(publish.label)}` : `${nonce}-${counter}`;
        const result = await submitStep(
            host,
            job,
            stepRequest(job, options.kind, {
                id,
                argv: [publish.entrypoint, ...publish.args],
                cwd: publish.inRepo ? repo : null,
                // The literals are paths and code; the claim env only for a step that reads it.
                env: {
                    ...(publish.env ? claimStepEnv(job, options.githubToken) : {}),
                    ...(publish.envLiterals ?? {}),
                },
                timeoutMs: PUBLISH_STEP_TIMEOUT_MS,
            }),
            options.signal
        );
        if (result.exitCode !== 0 || result.timedOut) throw new Error(detailOf(result, PUBLISH_STEP_TIMEOUT_MS));
        return { stdout: result.stdout };
    };
}

/**
 * The startup sync (or, for a claim that continues a session, the restore) as one supervised step:
 * a starting claim gets fetch + create-or-rebase, with the board's GitHub token for the fetch when
 * the loop got one; a continuing claim gets RESTORE=1 and no env at all — nothing that touches the
 * remote (issue #58). The step is never abandoned mid-write: a stand-down kills the group instead,
 * which rejects it.
 */
export async function runSyncStep(host: StepHost, job: BoardJob, githubToken?: string): Promise<SyncResult> {
    const { config } = host;
    const clone = repoPath(config, job);
    const worktree = worktreeDir(config, job);
    if (!clone || !worktree) return { ok: true, reason: null }; // nothing synced, nothing to fail either
    const restore = claimContinuesSession(job);
    const base = baseBranchOf(job);
    const result = await submitStep(
        host,
        job,
        stepRequest(job, 'sync', {
            id: '1',
            argv: ['node', '-e', gitWorktreeScript],
            env: {
                ...(restore ? {} : claimStepEnv(job, githubToken)),
                REPO: clone,
                WORKTREE: worktree,
                BRANCH: worktreeBranch(job),
                // Restore mode: the script's "keep the tree as the task left it, remote untouched" switch.
                ...(restore ? { RESTORE: '1' } : {}),
                ...(base ? { BASE_BRANCH: base } : {}),
                // The fetch's credential helper CODE, only beside a token: a public repo with none
                // keeps its plain unauthenticated fetch, which a helper answering an empty password
                // would break. The token itself is the step env above.
                ...(!restore && githubToken ? { CRED_HELPER: CREDENTIAL_HELPER } : {}),
            },
            timeoutMs: SYNC_DEADLINE_MS,
        })
    );
    if (result.timedOut) {
        return { ok: false, reason: `the worktree sync failed: ${detailOf(result, SYNC_DEADLINE_MS)}` };
    }
    return parseLastJsonLine<SyncResult>(result.stdout, () => ({
        ok: false,
        reason:
            result.exitCode === 0
                ? `${syncUnreadable.reason}: ${result.stdout.trim().slice(-ERROR_PREVIEW_CHARS)}`
                : `the worktree sync failed: ${detailOf(result, SYNC_DEADLINE_MS)}`,
    }));
}

const ERROR_PREVIEW_CHARS = 200;

/** The terminal reclaim as one supervised step: the clone and the worktree by env, no credential. */
export async function runReclaimStep(host: StepHost, job: BoardJob): Promise<ReclaimResult> {
    const { config } = host;
    const clone = repoPath(config, job);
    const worktree = worktreeDir(config, job);
    if (!clone || !worktree) return { ok: true, removed: false, reason: null };
    const result = await submitStep(
        host,
        job,
        stepRequest(job, 'reclaim', {
            id: '1',
            argv: ['node', '-e', gitWorktreeRemoveScript],
            // The thread's review roots go with it: the caller thread owns the cleanup of every review it asked for.
            env: { REPO: clone, WORKTREE: worktree, REVIEW_ROOTS: reviewRootsDir(config, job) ?? '' },
            timeoutMs: RECLAIM_TIMEOUT_MS,
        })
    );
    if (result.timedOut) {
        return {
            ok: false,
            removed: false,
            reason: `the worktree reclaim failed: ${detailOf(result, RECLAIM_TIMEOUT_MS)}`,
        };
    }
    return parseLastJsonLine<ReclaimResult>(result.stdout, () => ({
        ok: false,
        removed: false,
        reason:
            result.exitCode === 0
                ? `${reclaimUnreadable.reason}: ${result.stdout.trim().slice(-ERROR_PREVIEW_CHARS)}`
                : `the worktree reclaim failed: ${detailOf(result, RECLAIM_TIMEOUT_MS)}`,
    }));
}

/**
 * One block-helper step (issue #207): an allowlisted, board-owned script, run in the task worktree
 * with its bounded input as a literal. Only a github-writing helper gets the claim env, with the
 * fresh token the loop minted laid over it; an unknown id fails before anything is submitted. A
 * receipted helper given its effect runs bracketed by its receipt (`helper-receipts.ts`, issue
 * #826). A lost supervisor is thrown (`stepLost`): no verdict on the helper, the attempt's loss.
 */
export async function runHelperStep(
    host: StepHost,
    job: BoardJob,
    plan: HelperPlan,
    { token, signal, effectId }: HelperCall = {}
): Promise<HelperResult> {
    const descriptor = lookupHelper(plan.helperId);
    if (!descriptor) {
        return {
            ok: false,
            reason: 'unknown_helper',
            message: `no allowlisted helper is registered as "${plan.helperId}"`,
        };
    }
    const worktree = worktreeDir(host.config, job);
    // The receipt's MAC key: with none, a receipt anyone could forge is never kept at all.
    const key = host.config.boardToken;
    const run = () => submitHelper(host, job, { plan, descriptor }, { token, signal });
    if (!descriptor.receipted || !effectId || !worktree || !key) return run();
    const ledger = supervisedStepRunner(host, job, { kind: 'helper', signal });
    return withHelperReceipt(ledger, { worktree, key, effectId }, run);
}

async function submitHelper(
    host: StepHost,
    job: BoardJob,
    { plan, descriptor }: { plan: HelperPlan; descriptor: HelperDescriptor },
    { token, signal }: HelperCall
): Promise<HelperResult> {
    try {
        const result = await submitStep(
            host,
            job,
            stepRequest(job, 'helper', {
                id: randomUUID(),
                argv: ['node', '-e', descriptor.scriptBody],
                cwd: worktreeDir(host.config, job),
                env: {
                    ...(plan.githubWriting ? claimStepEnv(job, token) : {}),
                    HELPER_INPUT: helperInputValue(plan),
                },
                timeoutMs: HELPER_TIMEOUT_MS,
            }),
            signal
        );
        if (result.timedOut) {
            return { ok: false, reason: 'timeout', message: `the helper exceeded its ${HELPER_TIMEOUT_MS}ms bound` };
        }
        if (result.exitCode !== 0) {
            return { ok: false, reason: 'runner_error', message: detailOf(result, HELPER_TIMEOUT_MS) };
        }
        return parseHelperOutput(descriptor, result.stdout);
    } catch (e) {
        if (stepLost(e)) throw e;
        return { ok: false, reason: 'runner_error', message: (e as Error).message };
    }
}

/** One declared gate (or the setup) as the gate container runs it: the command, in the worktree, with its env. */
export interface GateStepRequest {
    command: string;
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
}

/**
 * One gate execution as a supervised step (issue #773): the supervisor hands it to the group's gate
 * container through the gate mailbox. Every execution is a step of its own — a gate run again is run
 * again — while a redelivery of this one call keeps its id and invocation (`submitStep`), so the
 * supervisor's ledger only ever answers the same request. An abort of `signal` cancels it through the
 * channel (`StepSink.cancel`), never as a step queued behind the one it cancels. A lost supervisor
 * rejects (`stepLost`): no verdict on the gate.
 */
export async function runGateStep(
    host: Pick<StepHost, 'sink'>,
    job: BoardJob,
    gate: GateStepRequest,
    signal?: AbortSignal
): Promise<StepResult> {
    if (signal?.aborted) throw new Error('the gate was cancelled before it was submitted');
    const token = controlTokenOf(job);
    const step = stepRequest(job, 'gate', {
        id: randomUUID(),
        argv: [gate.command],
        cwd: gate.cwd,
        env: gate.env,
        timeoutMs: gate.timeoutMs,
    });
    const cancel = (): void => host.sink.cancel(token, step.id);
    signal?.addEventListener('abort', cancel, { once: true });
    try {
        return await submitStep(host, job, step, signal);
    } finally {
        signal?.removeEventListener('abort', cancel);
    }
}

/** How long the supervisor may take over one read or bump of the services' generations: a few files. */
const SERVICE_STEP_TIMEOUT_MS = 30_000;

/**
 * One `restart` step (issue #773 D9): the supervisor reads which of `names` have not acknowledged
 * their generation (`acked`), or bumps every one's (`bump`, refused unless all have) — instant
 * either way, so it never holds the steps behind it. A fresh id each time: a read must read now, and
 * a bump the caller asks again is a new one. A lost supervisor rejects (`stepLost`).
 */
export const runServiceGenerationStep = (
    host: Pick<StepHost, 'sink'>,
    job: BoardJob,
    { mode, names }: { mode: 'acked' | 'bump'; names: readonly string[] },
    bound?: Bound
): Promise<StepResult> => {
    // Inside a wait, the step ends at its deadline and on its kill, and is not even sent past it.
    const left = bound ? Math.min(SERVICE_STEP_TIMEOUT_MS, timeLeft(bound.deadline)) : SERVICE_STEP_TIMEOUT_MS;
    if (left === 0)
        return Promise.reject(new Error("the services' generation step was refused: its wait is out of time"));
    const ends = [
        ...(bound?.signal ? [bound.signal] : []),
        ...(bound && Number.isFinite(bound.deadline) ? [AbortSignal.timeout(timeLeft(bound.deadline))] : []),
    ];
    return submitStep(
        host,
        job,
        stepRequest(job, 'restart', { id: randomUUID(), argv: serviceRestartArgv(mode, names), timeoutMs: left }),
        ends.length > 0 ? AbortSignal.any(ends) : undefined
    );
};

/**
 * `go`: releases the attempt's agent, whose entrypoint waits for it, and hands the supervisor the
 * run budget as it stands now — the sync and the environment setup came out of it after the group
 * was specced.
 */
export const orderGo = (host: StepHost, job: BoardJob): Promise<StepResult> =>
    submitStep(
        host,
        job,
        stepRequest(job, 'go', {
            id: '1',
            env: { BUDGET_MS: String(runTimeoutMs(host.config, job)) },
            timeoutMs: ORDER_TIMEOUT_MS,
        })
    );

/** `finish`: ends the attempt's group; the supervisor finalizes and exits. */
export const orderFinish = (host: StepHost, job: BoardJob): Promise<StepResult> =>
    submitStep(host, job, stepRequest(job, 'finish', { id: '1', timeoutMs: ORDER_TIMEOUT_MS }));

/** What an executor lends the shared supervised-step members: its host, its groups, its own error words. */
export interface SupervisedGroups {
    host: StepHost;
    /** Whether the attempt's group already exists, read on every call. */
    hasGroup(job: BoardJob): boolean;
    /** Creates the attempt's group; a refusal rejects. */
    createGroup(job: BoardJob): Promise<unknown>;
    /** A refused group, as a failed helper's message. */
    errorDetail(e: unknown): string;
}

/**
 * The step host of an attempt whose first step is not its sync — an adopted run, whose agent
 * already ended under an earlier claim: a group is created for it on demand, a supervisor and no
 * agent, because the gates' probe, the helpers and the publish are still its steps. A group the
 * sync already created is simply answered.
 */
async function stepHostFor(groups: SupervisedGroups, job: BoardJob): Promise<StepHost> {
    if (!groups.hasGroup(job)) await groups.createGroup({ ...job, agent: false });
    return groups.host;
}

/**
 * The supervised steps both executors run the same way: the publish (`publishCheckout`, the one
 * workflow), the post-gate tree probe, the review snapshot and the allowlisted helpers, each over
 * the attempt's supervisor. The probe and the review snapshot need no claim env; a stand-down ends
 * the wait for the answer, never the supervisor. An unknown helper id creates nothing
 * (`runHelperStep` refuses it first), and a group the executor refuses is a failed helper; only a
 * lost supervisor (`stepLost`) is thrown.
 */
export function supervisedStepMembers(
    groups: SupervisedGroups
): Pick<Runner, 'publishGit' | 'probeTree' | 'snapshotTree' | 'runHelper'> {
    return {
        publishGit: async (job, githubToken, options) =>
            publishCheckout(
                groups.host.config,
                job,
                options,
                supervisedStepRunner(await stepHostFor(groups, job), job, { kind: 'publish', githubToken })
            ),
        probeTree: async (job, signal) =>
            probeTreeFingerprint(
                groups.host.config,
                job,
                supervisedStepRunner(await stepHostFor(groups, job), job, { kind: 'probe', signal })
            ),
        snapshotTree: async (job, key, signal) =>
            snapshotTree(
                groups.host.config,
                job,
                key,
                supervisedStepRunner(await stepHostFor(groups, job), job, { kind: 'snapshot', signal })
            ),
        runHelper: async (job, plan, call = {}) => {
            if (!lookupHelper(plan.helperId)) return runHelperStep(groups.host, job, plan, call);
            try {
                return await runHelperStep(await stepHostFor(groups, job), job, plan, call);
            } catch (e) {
                if (stepLost(e)) throw e;
                return { ok: false, reason: 'runner_error', message: groups.errorDetail(e) };
            }
        },
    };
}

/**
 * What a review's close-time export step is given (issue #774): the exporter token the caller's
 * control channel opened for THIS review row (bound to the row's lease and identity, never the
 * caller's own), and where an opencode review's readout goes — the driver parses and uploads it
 * under the row, since the opencode readout is a read, not a stream.
 */
export interface ReviewExporter {
    token: string;
    readout(stdout: string): Promise<void>;
}

/** What stands beside a review run: the signal that cancels it and the export of its transcript. */
export interface ReviewControl {
    signal?: AbortSignal;
    exporter?: ReviewExporter;
    /**
     * Which run of this lease the review is (1, the default): a request the reviewer container lost is
     * asked again as a new step, since the ledger answers a repeated step id with its first answer.
     */
    round?: number;
    /** False while the driver would run again an answer that carries no exit: nothing is exported for a round it discards. */
    final?: boolean;
}
