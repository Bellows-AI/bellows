/**
 * The verdict half of one attempt: the publish itself and the report that lands the outcome on
 * the board — split out of `loop-run.ts` purely for that file's line budget. The attempt's own
 * fencing (the setup, the run, the stand-downs) stays there; what is publish-due, the status, the
 * failure kind and the annotations all come from the fault ledger (`loop-ledger.ts`).
 * `loop-run.ts` is the only importer.
 */

import type { Board, BoardJob, LeaseState, VerdictEvidence } from './board.js';
import { runTimeoutMs } from './claim.js';
import type { HelperFailureReport } from './helpers.js';
import { type GateFailure, setupFailureNote } from './loop-gates.js';
import {
    causeOf,
    deadServiceNote,
    draftable,
    kindOf,
    ledgerOf,
    type Ledger,
    outputOf,
    publishEligible,
    statusOf,
} from './loop-ledger.js';
import { end } from './loop-conclusion.js';
import { stepLost } from './step-control.js';
import type { AttemptCtx, LoopRuntime, VerdictBody } from './loop-types.js';
import { type PublishOptions, type PublishResult, publishFailed } from './publish.js';
import type { DeadService, RunOutcome } from './runner.js';
import type { GateRunNote, TimeoutActivity } from './timeout-note.js';
import { timeoutNote } from './timeout-note.js';

/**
 * Whether this attempt's ledger calls for a publish at all: succeeded, ungated or passed, publish
 * not disabled. The caller fences around the two halves below.
 */
function publishDue(job: BoardJob, ledger: Ledger): boolean {
    return publishEligible(ledger) && job.publish !== false;
}

/**
 * What this ledger publishes: the end-of-run publish, a draft of finished work the services or
 * gates alone failed — kept recoverable rather than stranded (issues #560, #573) — or nothing.
 */
export function publishModeOf(job: BoardJob, ledger: Ledger): 'publish' | 'draft' | null {
    if (publishDue(job, ledger)) return 'publish';
    // An objective claim carries no `publish` key; a workflow node's publish is the graph's to
    // order, so its failed gate still fires the `gate-failed` edge instead of shipping a draft.
    return draftable(ledger, job.publish === undefined) && job.publish !== false ? 'draft' : null;
}

/** The push's options for `mode`, bound to `revision` when the policy named one; none for a plain publish. */
export function publishOptionsOf(mode: 'publish' | 'draft', revision: string | null): PublishOptions | undefined {
    if (mode === 'draft') return revision === null ? { draft: true } : { draft: true, revision };
    return revision === null ? undefined : { revision };
}

/**
 * Pushes the branch and opens the PR. A lost supervisor (`stepLost`) is thrown, never a failed publish:
 * the caller hands the attempt back as an interruption (#925). Deliberately NOT raced against the stand-down and not
 * abortable: a push already in flight is not a thing the driver can take back, and half a push is
 * worse than a fenced one. The caller fences before asking for the token instead (issue #472).
 */
export async function publishBranch(
    rt: LoopRuntime,
    job: BoardJob,
    githubToken: string | null,
    options?: PublishOptions
): Promise<PublishResult> {
    return rt.runner.publishGit(job, githubToken ?? undefined, options).catch((e: Error) => {
        if (stepLost(e)) throw e;
        return publishFailed(`the publish threw: ${e.message}`, 'unknown');
    });
}

/** The publication identity to ride the verdict, only when the publish really happened and landed. */
function publicationOf(
    published: PublishResult | null
): NonNullable<Parameters<Board['complete']>[1]['publication']> | null {
    if (
        published?.published &&
        published.repository &&
        published.prNumber &&
        published.prUrl &&
        published.branch &&
        published.baseBranch
    ) {
        return {
            repo: published.repository,
            prNumber: published.prNumber,
            prUrl: published.prUrl,
            headBranch: published.branch,
            baseBranch: published.baseBranch,
        };
    }
    return null;
}

/** What one attempt's conclusion needs to build and report its verdict. */
export interface FinishCtx {
    job: BoardJob;
    outcome: RunOutcome;
    failure: GateFailure | null;
    /** The declared services found dead before the gates, which skipped them (issue #423). */
    deadServices: readonly DeadService[];
    /** The services found dead before the gates and restarted for them (issue #560): noted, never faults. */
    recoveredServices: readonly DeadService[];
    helperFailure: HelperFailureReport | null;
    published: PublishResult | null;
    /** When the run ended — the stamp the timeout note's ages are measured from. */
    endedAt: number;
    /** How far the agent's questions pushed the run deadline out — the timeout note reports the extended one. */
    deadlineExtensionMs: number;
    /** The pump's liveness read at the moment the run ended — the timeout note's raw material. */
    activity: TimeoutActivity;
    /** The ad-hoc gate server's latest verdicts, read before the session's teardown clears them. */
    gateRuns: readonly GateRunNote[];
    /** Why declared gates were skipped (`skipWhyOf`), or null when they ran or none exist. */
    gatesSkipped: string | null;
    /** Whether a failed gate's tree differs from the synced one; null when unmeasured. */
    treeChanged: boolean | null;
    /** The revision-bound evidence record (set only under a policy); null when none was taken. */
    evidence: VerdictEvidence | null;
    /** Why the evidence policy refused the publish before anything was pushed; null when it did not. */
    policyRefusal: string | null;
}

/** The verdict output text, annotated with every fault on the ledger. */
function buildOutput(rt: LoopRuntime, finish: FinishCtx, ledger: Ledger): string {
    const { job, outcome, published } = finish;
    const { config, log } = rt;
    let output = outcome.timedOut
        ? `${outcome.output}\n${timeoutNote(
              runTimeoutMs(config, job) + finish.deadlineExtensionMs,
              finish.activity,
              finish.gateRuns,
              finish.endedAt
          )}`
        : outcome.output;
    if (published?.published) {
        output = `${output}\n[driver] published ${published.branch}${published.prUrl ? ` — ${published.prUrl}` : ''}`;
    }
    if (published && published.ok && !published.published) {
        // A silent no-op is how a missing `docker run` once hid behind "the checkout has not
        // been cloned yet" — the reason is the only way to tell an ordinary clean tree from a
        // publisher that cannot see the tree at all.
        log(`job ${job.id}: nothing to publish: ${published.reason}`);
    }
    const recovered = finish.recoveredServices.map((dead) => `\n[driver] ${deadServiceNote(dead, false, true)}`);
    return output + setupNotes(rt, finish) + recovered.join('') + outputOf(ledger, finish.gatesSkipped);
}

/**
 * What the verdict says about `environment.setup` (issue #733): on a timeout, how much of the run
 * budget it took — the kill note's budget is what was left; and a failure no gate pass reported.
 */
function setupNotes(rt: LoopRuntime, finish: FinishCtx): string {
    const { job, outcome, failure } = finish;
    const spent = outcome.timedOut && typeof job.setupMs === 'number' ? `\n${setupSpentNote(rt.config, job)}` : '';
    return spent + (job.setupFailure && !failure ? `\n${setupFailureNote(job.setupFailure)}` : '');
}

/** How much of the whole (unclamped) run budget `environment.setup` took; empty when none ran. */
export const setupSpentNote = (config: { jobTimeoutMs: number }, job: BoardJob): string =>
    typeof job.setupMs === 'number'
        ? `[driver] ${job.setupMs}ms of the ${config.jobTimeoutMs}ms run budget went to environment.setup`
        : '';

/** How long `environment.setup` ran before the agent (issue #733); absent when none ran. */
const setupMsOf = (job: BoardJob): { setupMs?: number } =>
    typeof job.setupMs === 'number' ? { setupMs: job.setupMs } : {};

/**
 * Lands the run's final verdict after any publish attempt: staged, completed, then the attempt torn
 * down (`end`, issue #821). A verdict is decided once and never rewritten (issue #820).
 */
export async function reportFinish(ctx: AttemptCtx, finish: FinishCtx): Promise<void> {
    const body = verdictOf(ctx.rt, finish);
    const verdict = await end(ctx, { kind: 'verdict', verdict: body });
    if (verdict !== null) ctx.rt.log(finishLine(finish, verdict, body.status, body.exitCode));
}

/** What the run's close-time reads lifted; an unmeasured read stays off the report. */
function runReadsOf(
    outcome: RunOutcome
): Pick<VerdictBody, 'contextTokens' | 'contextCostUsd' | 'agentTurns' | 'summary'> {
    return {
        contextTokens: outcome.contextTokens ?? null,
        contextCostUsd: outcome.costUsd ?? null,
        // A number only: an unmeasured read stays off the report and the board stores null.
        ...(typeof outcome.agentTurns === 'number' ? { agentTurns: outcome.agentTurns } : {}),
        // The run's last words, when the close-time read lifted them; absent stays absent.
        ...(outcome.summary ? { summary: outcome.summary } : {}),
    };
}

/** The verdict body a finished run reports, built from its fault ledger. */
function verdictOf(rt: LoopRuntime, finish: FinishCtx): VerdictBody {
    const { job, outcome, failure, published } = finish;
    const ledger = ledgerOf(finish);
    const status = statusOf(ledger);
    const exitCode = failure ? failure.exitCode : outcome.exitCode;
    const output = buildOutput(rt, finish, ledger);
    const publication = publicationOf(published);
    const failureKind = kindOf(ledger);
    const failureCause = causeOf(ledger);

    return {
        status,
        exitCode,
        output,
        ...runReadsOf(outcome),
        ...setupMsOf(job),
        // The structured failure reason (issue #339); a success reports no kind at all.
        ...(failureKind ? { failureKind } : {}),
        ...(failureCause ? { failureCause } : {}),
        ...(finish.treeChanged !== null ? { treeChanged: finish.treeChanged } : {}),
        ...(finish.evidence ? { evidence: finish.evidence } : {}),
        ...(publication ? { publication } : {}),
    };
}

/** The line a delivered verdict leaves in the log. */
function finishLine(finish: FinishCtx, verdict: LeaseState, status: string, exitCode: number | null): string {
    const { job, failure, helperFailure } = finish;
    if (verdict === 'lost') return `job ${job.id}: finished ${status}, but the board had already reclaimed it`;
    return `job ${job.id}: ${status} (exit ${exitCode}${failure ? ', gates' : ''}${helperFailure ? ', helper' : ''})`;
}

export async function report(
    rt: LoopRuntime,
    job: BoardJob,
    result: Parameters<Board['complete']>[1]
): Promise<LeaseState> {
    return rt.report(job, result);
}
