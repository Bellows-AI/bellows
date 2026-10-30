import { bindAuthorizedConnectionRow, markRequirementAmbiguousRow } from '../db/jobs/job-store-connections.js';
import { completeAuthorization, hashState } from './authorization-complete.js';
import { bindTargetOf } from './authorization-store.js';
import type { CompleteAuthorizationInput, CompleteAuthorizationResult, FlowCtx } from './authorization-types.js';
import type { TrustedIntegrationContext } from './trusted-context.js';

/**
 * The callback, then the bind: a connect started from a task's Connect block binds what it made to that
 * task, as the person who made it, answering the thread's open requirement. A refusal (not the execution user, an
 * unknown task) or a failure leaves the connection made and the redirect `connected`; the block stays and the
 * person binds it by hand.
 */
export async function completeAndBind(
    fc: FlowCtx,
    ctx: TrustedIntegrationContext,
    input: CompleteAuthorizationInput,
    signal: AbortSignal | undefined
): Promise<CompleteAuthorizationResult> {
    const done = await completeAuthorization(fc, ctx, input, signal);
    if (!done.ok || ctx.principal.kind !== 'user' || !input.state) return done;
    const owner = { orgId: fc.orgId, userId: ctx.principal.userId, stateHash: hashState(input.state) };
    try {
        const target = await bindTargetOf(fc.sql, owner);
        if (target) {
            // A reconnect answers for the connection it was started from; a connect that made several (one account,
            // several sites) picks none for the person: the requirement asks them to choose.
            const made = target.connectionId ? [target.connectionId] : target.connectionIds;
            if (made.length > 1) {
                await markRequirementAmbiguousRow(fc.sql, {
                    orgId: fc.orgId,
                    jobId: target.jobId,
                    provider: target.provider,
                    userId: owner.userId,
                });
            } else {
                await bindAuthorizedConnectionRow(fc.sql, {
                    orgId: fc.orgId,
                    jobId: target.jobId,
                    connectionId: made[0] ?? done.connectionId,
                    userId: owner.userId,
                });
            }
        }
    } catch {
        // Not logged: an error may quote a code or a token. The connection is made either way.
    }
    return done;
}
