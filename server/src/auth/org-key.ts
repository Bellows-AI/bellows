import { createHmac } from 'node:crypto';

/**
 * The per-organization key every claim carries (`Claim.orgKey`, docs/auth.md). The drivers key gate identities
 * and helper receipts with it, so every driver serving an organization computes the same — whatever credential it
 * holds — and both survive a takeover, while a driver scoped to one organization never learns another's key.
 * Derived, never stored: an HMAC of the organization id under the secret store's fingerprint key, which never
 * rotates (docs/secrets.md), with a label of its own so no other use of that key yields the same bytes.
 */
export function orgKeyDeriver(secret: Buffer): (orgId: string) => string {
    return (orgId) => createHmac('sha256', secret).update(`bellows-org-key-v1|${orgId}`).digest('hex');
}
