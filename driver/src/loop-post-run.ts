/**
 * The post-run phases after the gates (issue #829 resumes them from the board's checkpoints): the
 * post-helpers, then the publish. Split out of `loop-run.ts` for its line budget.
 */

import { evidenceDecision, gatesEvidenceOf } from './evidence-policy.js';
import type { HelperFailureReport } from './helpers.js';
import { setupDecision } from './loop-fence.js';
import { runPostHelperPhase } from './loop-helpers.js';
import { askGithubToken } from './loop-github.js';
import { end, endIfDown } from './loop-conclusion.js';
import { postHelperSkipWhy, ledgerOf } from './loop-ledger.js';
import { type PhaseChain, phasesOf } from './loop-phase-checkpoints.js';
import type { RunPhaseResult } from './loop-run.js';
import { publishBranch, publishModeOf, publishOptionsOf } from './loop-verdict.js';
import { type AttemptCtx, STOOD_DOWN } from './loop-types.js';
import type { PublishOptions, PublishResult } from './publish.js';

/** The post-helpers' failure, or `STOOD_DOWN` once they ended the attempt: it is down, or a lost supervisor interrupted it. */
async function endingPostHelpers(
    ctx: AttemptCtx,
    skipReason: string | null
): Promise<HelperFailureReport | null | typeof STOOD_DOWN> {
    const found = await runPostHelperPhase(ctx, skipReason);
    if (await endIfDown(ctx, 'its post-helpers')) return STOOD_DOWN;
    if (found === null || found === STOOD_DOWN || !('halt' in found)) return found;
    await end(ctx, setupDecision(found));
    return STOOD_DOWN;
}

/** The post-helpers' phase, served from the board's checkpoint on an adopted run; `STOOD_DOWN` once the attempt settled. */
async function postPhase(
    ctx: AttemptCtx,
    outcome: RunPhaseResult,
    phases: PhaseChain
): Promise<HelperFailureReport | null | typeof STOOD_DOWN> {
    const postApplies = (ctx.job.helperPlans ?? []).some((plan) => plan.phase === 'post');
    const resumed = phases.resumePost(postApplies);
    if (resumed) return resumed.failure;
    const failure = await endingPostHelpers(ctx, postHelperSkipWhy(outcome.outcome));
    if (failure !== STOOD_DOWN && postApplies) await phases.record('post', null, { failure });
    return failure;
}

/**
 * The publish: an adopted run's publication that already landed is not pushed again (nothing is
 * asked or sent); otherwise the token, the fenced push and the checkpoint of one that landed.
 * `STOOD_DOWN` once the attempt settled.
 */
async function publishPhase(
    ctx: AttemptCtx,
    phases: PhaseChain,
    options: PublishOptions | undefined
): Promise<PublishResult | null | typeof STOOD_DOWN> {
    const { rt, job, state } = ctx;
    const resumed = phases.resumePublish();
    if (resumed) return resumed;
    const githubToken = await askGithubToken(rt, job, 'the publish');
    // The fence sits BETWEEN the ask and the push: a Stop during the ask killed the runner,
    // and pushing now would outlive it. The push itself is never fenced — it cannot be
    // recalled (issue #472).
    if (await endIfDown(ctx, 'its publish')) return STOOD_DOWN;
    let published = await publishBranch(rt, job, githubToken, options);
    // A lease lost while the push ran stands down here WITHOUT reporting what it pushed: the
    // next holder re-runs the publish (`publishBranch` is the one call that is not abortable).
    if (await endIfDown(ctx, 'its publish')) return STOOD_DOWN;
    // The agent already shipped its work as a draft: a clean tree leaves nothing to push, and
    // the verdict still carries the publication the agent made.
    if (published?.ok && !published.published && state.draftPublication) published = state.draftPublication;
    if (published?.ok) await phases.record('publish', null, published);
    return published;
}

/**
 * The post-helpers, then the publish, each fenced on a stand-down: a Stop, lost lease or Remove
 * that lands during either must not push to a tree another attempt owns or open a PR for a
 * deleted thread. Null when the attempt stood down (already settled), nothing left to report.
 */
export async function runPostHelpersAndPublish(
    ctx: AttemptCtx,
    outcome: RunPhaseResult
): Promise<{
    helperFailure: HelperFailureReport | null;
    published: PublishResult | null;
    policyRefusal: string | null;
} | null> {
    const { job } = ctx;
    const phases = await phasesOf(ctx);
    const helperFailure = await postPhase(ctx, outcome, phases);
    if (helperFailure === STOOD_DOWN) return null;
    const ledger = ledgerOf({ ...outcome, helperFailure, published: null });
    const mode = publishModeOf(job, ledger);
    if (mode === null) return { helperFailure, published: null, policyRefusal: null };
    // The configured evidence is enforced HERE, whatever the agent chose to run: a refusal
    // pushes nothing, and an authorisation binds the push to the revision it assessed. A
    // refused draft is no refusal of its own: the services fault already fails the verdict.
    const decision = evidenceDecision(job.policy, gatesEvidenceOf(outcome.evidence), job.review);
    if (!decision.ok) {
        return { helperFailure, published: null, policyRefusal: mode === 'draft' ? null : decision.reason };
    }
    const published = await publishPhase(ctx, phases, publishOptionsOf(mode, decision.revision));
    if (published === STOOD_DOWN) return null;
    return { helperFailure, published, policyRefusal: null };
}
