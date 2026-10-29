import type {
    OperationId,
    OperationStatus,
    SecretIdentity,
    SecretRef,
    SecretStore,
    SecretVersion,
} from '../secrets/secret-store.js';

/**
 * The durable fence at the storage boundary. A recorded operation ID binds to the first request that reaches the
 * SecretStore (docs/secrets.md; `secrets-conformance.ts` pins it for every backend), so before ownership of an
 * operation is released on a `not-found`, the ID is bound to a request that can never apply: a delete at a version
 * that is never active. A holder that was paused before its request reached the store is then refused
 * `operation-id-reused` whatever the clocks say.
 */

/** Real versions are `ver_<uuid>`; this one is never active, so the delete is always a recorded refusal. */
const NEVER_ACTIVE = 'ver_none' as SecretVersion;

/**
 * `fenced`: the ID is bound to the poison (or can no longer be used): release is safe.
 * `bound`: the holder's own request won the ID: reconcile it again.
 * `inconclusive`: the store did not say: leave the row for the next pass.
 */
export type Fence = 'fenced' | 'bound' | 'inconclusive';

export async function fenceOperation(
    secrets: SecretStore,
    input: { identity: SecretIdentity; ref: SecretRef; operationId: OperationId; signal: AbortSignal | undefined }
): Promise<Fence> {
    const answer = await secrets
        .delete({
            identity: input.identity,
            ref: input.ref,
            operationId: input.operationId,
            expectedVersion: NEVER_ACTIVE,
            signal: input.signal,
        })
        .catch(() => null);
    if (!answer || answer.ok) return 'inconclusive';
    const { code, reason } = answer.error;
    if (code === 'not-found' && reason === 'reference-not-found') return 'fenced';
    if (code === 'conflict' && reason === 'stale-version') return 'fenced';
    if (code === 'invalid-input' && reason === 'operation-id-expired') return 'fenced';
    if (code === 'conflict' && reason === 'operation-id-reused') return 'bound';
    return 'inconclusive';
}

export type Settled = { kind: 'status'; status: OperationStatus } | { kind: 'fenced' } | { kind: 'inconclusive' };

/**
 * The recorded operation's status, with a `not-found` made final only by a fence: `fenced` means it will never run,
 * `status` is what the store holds (also after the holder's own request won the ID), `inconclusive` leaves the row.
 */
export async function reconcileFenced(
    secrets: SecretStore,
    input: { identity: SecretIdentity; ref: SecretRef; operationId: OperationId },
    fenceTimeoutMs: number
): Promise<Settled> {
    const reconcile = () => secrets.reconcileOperation(input).catch(() => null);
    let answer = await reconcile();
    if (answer && !answer.ok && answer.error.code === 'not-found') {
        // `not-found` only means "not yet": a holder paused before its request would still write.
        const verdict = await fenceOperation(secrets, { ...input, signal: AbortSignal.timeout(fenceTimeoutMs) });
        if (verdict === 'fenced') return { kind: 'fenced' };
        if (verdict === 'inconclusive') return { kind: 'inconclusive' };
        answer = await reconcile();
    }
    return answer?.ok ? { kind: 'status', status: answer.status } : { kind: 'inconclusive' };
}
