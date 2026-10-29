import type { Initiator, Principal } from '@factory-ai/core';

/**
 * Who a credential is resolved for, as the board itself established it. The type is branded with a symbol this
 * module alone can name, and every value is also recorded in a module-private set, so neither a plain object nor
 * a spread copy of a real context passes `isTrustedContext`. The core context shapes confer nothing; only the
 * three constructors below mint trust, from a session the auth plugin resolved or a lease-verified execution.
 */
declare const trustedBrand: unique symbol;

export interface TrustedIntegrationContext {
    readonly orgId: string;
    readonly principal: Principal;
    readonly initiator: Initiator;
    readonly [trustedBrand]: true;
}

const minted = new WeakSet<object>();

function mint(orgId: string, principal: Principal, initiator: Initiator): TrustedIntegrationContext {
    const context = Object.freeze({ orgId, principal, initiator }) as unknown as TrustedIntegrationContext;
    minted.add(context);
    return context;
}

export const isTrustedContext = (value: unknown): value is TrustedIntegrationContext =>
    typeof value === 'object' && value !== null && minted.has(value);

/** A signed-in person: BEL-61's routes call this with the caller the auth plugin resolved for the request. */
export const contextOfSession = (caller: { user: { id: string } }, orgId: string): TrustedIntegrationContext =>
    mint(orgId, { kind: 'user', userId: caller.user.id }, { kind: 'user', userId: caller.user.id });

/** A lease-verified task attempt acting as the thread's execution user (BEL-60's callers). */
export const contextOfExecution = (input: {
    orgId: string;
    executionUserId: string;
    jobId: string;
    attempt: number;
}): TrustedIntegrationContext =>
    mint(
        input.orgId,
        { kind: 'user', userId: input.executionUserId },
        { kind: 'job', jobId: input.jobId, attempt: input.attempt }
    );

/** A service principal. Minting it is allowed; resolving a credential for it is refused until BEL-143. */
export const contextOfService = (input: { orgId: string; serviceId: string }): TrustedIntegrationContext =>
    mint(input.orgId, { kind: 'service', serviceId: input.serviceId }, { kind: 'user', userId: input.serviceId });
