import {
    bindAuthorizedConnectionRow,
    connectionsAtSite,
    markRequirementAmbiguousRow,
    openRequirementTargetRow,
} from '../db/jobs/job-store-connections.js';
import { completeAuthorization, hashState } from './authorization-complete.js';
import { bindTargetOf } from './authorization-store.js';
import type { CompleteAuthorizationInput, CompleteAuthorizationResult, FlowCtx } from './authorization-types.js';
import type { TrustedIntegrationContext } from './trusted-context.js';

/**
 * The connections an authorization made that answer the task's requirement: a reconnect answers for the one it
 * started from; a connect answers with what it made, narrowed to the site a requirement names (a site-less
 * requirement takes them all).
 */
async function connectionsToBind(
    fc: FlowCtx,
    target: NonNullable<Awaited<ReturnType<typeof bindTargetOf>>>,
    userId: string,
    madeId: string
): Promise<string[]> {
    if (target.connectionId) return [target.connectionId];
    const needs = await openRequirementTargetRow(fc.sql, {
        orgId: fc.orgId,
        jobId: target.jobId,
        provider: target.provider,
        userId,
    });
    const made = target.connectionIds.length > 0 ? target.connectionIds : [madeId];
    return connectionsAtSite(fc.sql, { orgId: fc.orgId, connectionIds: made, target: needs });
}

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
            const made = await connectionsToBind(fc, target, owner.userId, done.connectionId);
            if (made.length > 1) {
                await markRequirementAmbiguousRow(fc.sql, {
                    orgId: fc.orgId,
                    jobId: target.jobId,
                    provider: target.provider,
                    userId: owner.userId,
                });
            } else if (made.length === 1) {
                await bindAuthorizedConnectionRow(fc.sql, {
                    orgId: fc.orgId,
                    jobId: target.jobId,
                    connectionId: made[0]!,
                    userId: owner.userId,
                });
            }
        }
    } catch {
        // Not logged: an error may quote a code or a token. The connection is made either way.
    }
    return done;
}
