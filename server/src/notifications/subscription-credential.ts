import { decodeEnvSecret, untilAborted } from '../db/env-secrets.js';
import type { SecretIdentity, SecretRef, SecretStore, SecretVersion } from '../secrets/secret-store.js';

/**
 * A subscription's channel credential lives in the secret store (docs/notifications.md): the row keeps the
 * opaque reference and the version it was written at. The identity is rebuilt from the row's slot on every
 * call and never stored, so a reference copied to another subscription or organization reads as
 * `identity-mismatch`.
 */
export function subscriptionSecretIdentity(orgId: string, subscriptionId: string): SecretIdentity {
    return {
        owner: { kind: 'organization', orgId },
        scope: { type: 'organization', id: orgId },
        purpose: 'notification-credential',
        owningRecord: { type: 'notification-subscription', id: subscriptionId },
    };
}

/**
 * The credential, or null for every answer that is not a confirmed value of the stored version: a refusal, a
 * throw, a version other than the row's, bytes that are not UTF-8, a malformed reference, or a store that
 * outlasts `signal`. Null is inconclusive, never "the credential is gone": the caller retries, it never parks.
 */
export async function readSubscriptionCredential(
    secrets: SecretStore,
    { identity, ref, version }: { identity: SecretIdentity; ref: unknown; version: unknown },
    signal: AbortSignal
): Promise<string | null> {
    if (typeof ref !== 'string' || ref === '' || typeof version !== 'string' || version === '') return null;
    try {
        const answer = await untilAborted(secrets.readActive({ identity, ref: ref as SecretRef, signal }), signal);
        if (answer.lost || !answer.value.ok) return null;
        if ((answer.value.version as SecretVersion) !== version) return null;
        return decodeEnvSecret(answer.value.value);
    } catch {
        return null;
    }
}
