import { createHash, randomBytes } from 'node:crypto';
import { safeReturnPath } from '../auth/session.js';
import {
    completeAuthorization as complete,
    hashState,
    recoverAuthorization as recover,
    requireTrusted,
} from './authorization-complete.js';
import { connectionTarget, insertAuthorization } from './authorization-store.js';
import {
    type AuthorizationFlowDeps,
    type CompleteAuthorizationInput,
    type CompleteAuthorizationResult,
    DEFAULT_AUTHORIZATION_TTL_MS,
    type FlowCtx,
    type RecoverAuthorizationResult,
    redirectUriOf,
    type StartAuthorizationInput,
    type StartAuthorizationResult,
} from './authorization-types.js';
import type { TrustedIntegrationContext } from './trusted-context.js';

/**
 * The route-ready API of an outbound OAuth authorization: BEL-61's handlers parse a request, call these and send
 * the answer. There is no HTTP route in this change. The inputs carry no principal: the user and the organization
 * come from the trusted context alone, and the return path of a completion is always the one stored at the start.
 */

export type {
    AuthorizationClient,
    AuthorizationEvent,
    AuthorizationFailure,
    AuthorizationFlowDeps,
    CompleteAuthorizationInput,
    CompleteAuthorizationResult,
    CompleteFailure,
    RecoverAuthorizationResult,
    StartAuthorizationInput,
    StartAuthorizationResult,
} from './authorization-types.js';
export { callbackPath } from './authorization-types.js';

const RANDOM_BYTES = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const refuse = (reason: Extract<StartAuthorizationResult, { ok: false }>['reason']): StartAuthorizationResult => ({
    ok: false,
    reason,
});

export interface AuthorizationFlow {
    startAuthorization(
        ctx: TrustedIntegrationContext,
        input: StartAuthorizationInput,
        options?: { signal?: AbortSignal | undefined }
    ): Promise<StartAuthorizationResult>;
    completeAuthorization(
        ctx: TrustedIntegrationContext,
        input: CompleteAuthorizationInput,
        options?: { signal?: AbortSignal | undefined }
    ): Promise<CompleteAuthorizationResult>;
    /** One transaction that is stuck or past its time, by id; the recovery loop (slice 4) calls it. */
    recoverAuthorization(id: string): Promise<RecoverAuthorizationResult>;
}

async function start(
    fc: FlowCtx,
    ctx: TrustedIntegrationContext,
    input: StartAuthorizationInput
): Promise<StartAuthorizationResult> {
    requireTrusted(fc, ctx);
    if (ctx.principal.kind !== 'user') return refuse('bad-input');
    const userId = ctx.principal.userId;
    const hooks = fc.providers(input.provider);
    if (!hooks) return refuse('unknown-provider');
    const client = fc.clients(input.provider);
    const redirectUri = redirectUriOf(fc, input.provider);
    if (!client || !redirectUri) return refuse('not-configured');
    if (input.interactionId !== undefined && !UUID.test(input.interactionId)) return refuse('bad-input');

    let reconnect: { connectionId: string; accountId: string } | null = null;
    if (input.connectionId !== undefined) {
        if (!UUID.test(input.connectionId)) return refuse('bad-input');
        const target = await connectionTarget(fc.sql, {
            orgId: fc.orgId,
            userId,
            provider: input.provider,
            connectionId: input.connectionId,
        });
        if (!target) return refuse('not-found');
        reconnect = { connectionId: input.connectionId, accountId: target.accountId };
    }

    const state = randomBytes(RANDOM_BYTES).toString('base64url');
    const verifier = hooks.supportsPkce ? randomBytes(RANDOM_BYTES).toString('base64url') : null;
    const row = await insertAuthorization(fc.sql, {
        orgId: fc.orgId,
        userId,
        provider: input.provider,
        stateHash: hashState(state),
        verifier,
        returnTo: safeReturnPath(input.returnTo),
        interactionId: input.interactionId ?? null,
        ttlMs: fc.ttlMs,
        reconnect,
    });
    fc.log('started', row.id);
    const authorizeUrl = hooks.authorizeUrl({
        clientId: client.clientId,
        redirectUri,
        scopes: client.scopes,
        state,
        ...(verifier ? { codeChallenge: createHash('sha256').update(verifier).digest('base64url') } : {}),
    });
    return { ok: true, authorizationId: row.id, authorizeUrl, expiresAt: row.expiresAt };
}

export function createAuthorizationFlow(deps: AuthorizationFlowDeps): AuthorizationFlow {
    const fc: FlowCtx = {
        sql: deps.sql,
        orgId: deps.orgId,
        secrets: deps.secrets,
        lineage: deps.lineage,
        providers: deps.providers,
        clients: deps.clients,
        callbackOrigin: deps.callbackOrigin,
        ttlMs: deps.ttlMs ?? DEFAULT_AUTHORIZATION_TTL_MS,
        log: (event, authorizationId, failure) =>
            deps.log?.({ event, authorizationId, ...(failure ? { failure } : {}) }),
    };
    return {
        startAuthorization: (ctx, input) => start(fc, ctx, input),
        completeAuthorization: (ctx, input, options) => complete(fc, ctx, input, options?.signal),
        recoverAuthorization: (id) => recover(fc, id),
    };
}
