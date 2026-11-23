import type { MemberForgeGrants } from '../integrations/member-forge-grant.js';
import type { GithubMint } from '../routes/github-credential.js';
import { forgeOfRepo } from './forges.js';

/**
 * The token a PR write is made with (docs/connections.md). With member grants (`AUTH_MODE=github`) it is the thread
 * STARTER's user token, refreshed through the lineage; without them (`AUTH_MODE=none`) the org's installation token, and
 * no grant is ever read, so no forge wait can open. Only a confirmed `integration_required` is a wait: every other
 * answer that is not a token is `unavailable`, never a verdict about the grant.
 */
export type PrToken =
    | { ok: true; token: string; as: 'user' | 'installation' }
    | { ok: false; answer: 'waiting'; forge: string; reason: 'missing' | 'reconnect' }
    | { ok: false; answer: 'unavailable' }
    | { ok: false; answer: 'no-forge' };

export type PrTokenSource = (
    who: { orgId: string; repo: string; executionUserId: string | null },
    signal: AbortSignal
) => Promise<PrToken>;

const UNAVAILABLE: PrToken = { ok: false, answer: 'unavailable' };

export function createPrTokenSource(deps: {
    memberGrants: MemberForgeGrants | undefined;
    mint: GithubMint;
}): PrTokenSource {
    const { memberGrants, mint } = deps;

    const installationToken: PrTokenSource = async ({ orgId, repo }) => {
        const minted = await mint(orgId, repo).catch(() => undefined);
        if (minted === undefined) return UNAVAILABLE;
        return minted === null
            ? { ok: false, answer: 'no-forge' }
            : { ok: true, token: minted.token, as: 'installation' };
    };

    const memberToken = async (
        grants: MemberForgeGrants,
        { orgId, repo, executionUserId }: Parameters<PrTokenSource>[0],
        signal: AbortSignal
    ): Promise<PrToken> => {
        const forge = forgeOfRepo(repo);
        // A thread whose starter is gone has no grant to spend: that wait is the claim's (`starter-removed`).
        if (forge === null || executionUserId === null) return UNAVAILABLE;
        const result = await grants.accessToken(orgId, executionUserId, forge, { signal });
        if (result.ok) return { ok: true, token: result.accessToken, as: 'user' };
        const { outcome } = result;
        if (outcome.outcome !== 'integration_required') return UNAVAILABLE;
        const { reason } = outcome;
        return reason === 'missing' || reason === 'reconnect'
            ? { ok: false, answer: 'waiting', forge, reason }
            : UNAVAILABLE;
    };

    return (who, signal) => (memberGrants ? memberToken(memberGrants, who, signal) : installationToken(who, signal));
}
