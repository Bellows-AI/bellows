import type { FailureKind } from './board.js';
import { helperEffectId } from './helper-receipts.js';
import type { HelperFailureReport, HelperPlan, HelperResult, InvokeChild } from './helpers.js';
import { formatConcludeOutput, runHelperPlan } from './helpers.js';
import { askGithubToken } from './loop-github.js';
import { down, raceStep } from './loop-attempt.js';
import { interruptAttempt } from './loop-fence.js';
import { helperCauseOf } from './loop-ledger.js';
import type { AttemptCtx, SetupConclusion } from './loop-types.js';
import { STOOD_DOWN } from './loop-types.js';
import { stepLost } from './step-control.js';

/**
 * The loop's own two ends of the block-helper transport (issue #207, extended by #230's conclude
 * control and composite helper programs): when a declared pre/post helper runs, fenced by the same
 * lease/stop state as sync/gates/publish. Split from `loop-run.ts` purely to keep that file under
 * the linter's per-file line budget (`noExcessiveLinesPerFile` in biome.json) — the same seam `loop-gates.ts` already draws for the gate phase.
 * `runHelperPlan` (`helpers.ts`) owns the plain-vs-composite sequencing; this file supplies its own
 * `invokeChild` per phase — the exact fencing (and, for pre, standing the attempt down) each phase
 * already applied to a single plan, now applied identically to every child call a composite makes.
 */

/**
 * Runs the job's declared PRE block-helper steps, in the order the claim carries them, fenced by
 * the same lease/stop state every setup step races against. A required pre-helper that fails
 * answers a NAMED failure without ever launching the agent — the loop's own contract for this
 * phase. A pre-helper that succeeds with `control: 'conclude'` (issue #230) answers a conclusion:
 * the job is done right here — no agent, no gates, no post-helpers, no publish. A job with no
 * declared pre-helpers pays no extra work at all — the ordinary case for every workflow-less and
 * `agent`-node task today (docs/workflows.md: no producer wires a real plan onto a claim yet).
 *
 * It only answers: `runPhases` (`loop-run.ts`) acts on a conclusion through `concludeSetup`, so a
 * helper refusal cannot release the kubernetes checkout fence and forget to settle — the fence has
 * no runner coming to release it.
 */
export async function preHelperStep(ctx: AttemptCtx): Promise<SetupConclusion | null> {
    const { rt, job, state } = ctx;
    const { runner } = rt;
    const plans = (job.helperPlans ?? []).filter((plan) => plan.phase === 'pre');
    if (!plans.length) return null;

    // Applied to every child call a plan makes — one for a plain script plan, several in
    // declared order for a composite — so a stop or lost lease mid-composite is observed between
    // children, not just around the composite as a whole.
    const invokeChild =
        (planIndex: number): InvokeChild =>
        async (childPlan, childIndex) => {
            const token = childPlan.githubWriting
                ? ((await askGithubToken(rt, job, `the helper ${childPlan.helperId}`)) ?? undefined)
                : undefined;
            if (down(state)) return null;
            const effectId = helperEffectId(job, childPlan, planIndex, childIndex);
            const resultOut = await raceStep(
                state.signal,
                runner.runHelper(job, childPlan, { token, signal: state.signal, effectId })
            );
            return resultOut === null || down(state) ? null : resultOut.value;
        };

    for (const [planIndex, plan] of plans.entries()) {
        const result = await runPlanFenced(ctx, plan, invokeChild(planIndex));
        if (result === STOOD_DOWN) return STOOD_DOWN;
        if (!result.ok) {
            return {
                halt: 'fault',
                log: `pre-run helper "${plan.helperId}" failed (${result.reason}), failing without launching the agent`,
                verdict: {
                    status: 'failed',
                    exitCode: null,
                    output: `The declared pre-run helper "${plan.helperId}" failed (${result.reason}): ${result.message}`,
                    failureKind: 'helper' satisfies FailureKind,
                    failureCause: helperCauseOf(result.reason),
                },
            };
        }
        if (result.control === 'conclude') {
            return {
                halt: 'concluded',
                log: `pre-run helper "${plan.helperId}" concluded the job without launching the agent`,
                verdict: { status: 'succeeded', exitCode: 0, output: formatConcludeOutput(result.output) },
            };
        }
    }
    return null;
}

/**
 * Runs the job's declared POST block-helper steps, after the agent's run and its gates have
 * resolved and before publish is decided — the same window `runDeclaredGates` runs in, with the
 * heartbeat still live and `settle()` deliberately not yet called. Unlike the pre-phase, this runs
 * after any clean run, a failed gate included, and is skipped whole when `skipReason`
 * (`postHelperSkipWhy`) names a run that did not finish cleanly — never by helper kind, which
 * this generic transport must not encode.
 * Any stand-down (`down(state)`) ends it with STOOD_DOWN: a stopped, lost or removed attempt has no
 * verdict to contribute, and the caller stands the attempt down rather than publishing; so does a
 * lost supervisor, after its interruption settled the attempt. `conclude` (issue #230) is valid
 * only for a PRE helper — a post-helper naming it fails the verdict with a NAMED reason, exactly
 * like any other post-helper failure, rather than being silently ignored.
 */
export async function runPostHelperPhase(
    ctx: AttemptCtx,
    skipReason: string | null
): Promise<HelperFailureReport | null | typeof STOOD_DOWN> {
    const { rt, job, state } = ctx;
    const { runner, log } = rt;
    const plans = (job.helperPlans ?? []).filter((plan) => plan.phase === 'post');
    if (!plans.length) return null;
    if (skipReason !== null) {
        log(`job ${job.id}: post-run helpers skipped — ${skipReason}`);
        return null;
    }

    const invokeChild =
        (planIndex: number): InvokeChild =>
        async (childPlan, childIndex) => {
            if (down(state)) return null;
            const token = childPlan.githubWriting
                ? ((await askGithubToken(rt, job, `the helper ${childPlan.helperId}`)) ?? undefined)
                : undefined;
            if (down(state)) return null;
            const effectId = helperEffectId(job, childPlan, planIndex, childIndex);
            return runner.runHelper(job, childPlan, { token, signal: state.signal, effectId });
        };

    for (const [planIndex, plan] of plans.entries()) {
        const result = await runPlanFenced(ctx, plan, invokeChild(planIndex));
        if (result === STOOD_DOWN) return STOOD_DOWN;
        if (!result.ok) {
            log(`job ${job.id}: post-run helper "${plan.helperId}" failed: ${result.reason} — ${result.message}`);
            return { helperId: plan.helperId, result };
        }
        if (result.control === 'conclude') {
            log(
                `job ${job.id}: post-run helper "${plan.helperId}" reported "conclude" — only a pre-run helper ` +
                    'may conclude the job, failing'
            );
            return {
                helperId: plan.helperId,
                result: {
                    ok: false,
                    reason: 'invalid_control',
                    message: 'a post-run helper reported "conclude", which is only valid for a pre-run helper',
                },
            };
        }
    }
    return null;
}

/**
 * One declared plan run to its result, or STOOD_DOWN when the attempt is down — or when its
 * supervisor was lost mid-step (`stepLost`, issue #826). That is an infrastructure interruption,
 * never a helper failure: it settles the attempt here, and the receipt and the task's checkout stay
 * on the task volume for the claim that takes the job over. Any other throw is rethrown.
 */
async function runPlanFenced(
    ctx: AttemptCtx,
    plan: HelperPlan,
    invokeChild: InvokeChild
): Promise<HelperResult | typeof STOOD_DOWN> {
    try {
        return (await runHelperPlan(plan, invokeChild)) ?? STOOD_DOWN;
    } catch (e) {
        if (down(ctx.state)) return STOOD_DOWN;
        if (!stepLost(e)) throw e;
        const reason = `infrastructure loss: a ${plan.phase}-run helper's supervisor was lost (${(e as Error).message})`;
        await interruptAttempt(ctx, reason, null);
        return STOOD_DOWN;
    }
}
