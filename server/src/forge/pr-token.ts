import type { MemberForgeGrants } from '../integrations/member-forge-grant.js';
import type { GithubMint } from '../routes/github-credential.js';
import type { RepoRef } from '@factory-ai/core';
import { forgeOfRepo, isGithubRepo } from './forges.js';

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
    who: { orgId: string; repo: RepoRef; executionUserId: string | null },
    signal: AbortSignal
) => Promise<PrToken>;

const UNAVAILABLE: PrToken = { ok: false, answer: 'unavailable' };

/** The member's user token, refreshed through the lineage: the one mapping of a grant read to a token, a wait or `unavailable`. */
export async function memberTokenOf(
    grants: MemberForgeGrants,
    { orgId, userId, forge }: { orgId: string; userId: string; forge: string },
    signal: AbortSignal
): Promise<PrToken> {
    const result = await grants.accessToken(orgId, userId, forge, { signal });
    if (result.ok) return { ok: true, token: result.accessToken, as: 'user' };
    const { outcome } = result;
    if (outcome.outcome !== 'integration_required') return UNAVAILABLE;
    const { reason } = outcome;
    return reason === 'missing' || reason === 'reconnect'
        ? { ok: false, answer: 'waiting', forge, reason }
        : UNAVAILABLE;
}

/** What a merge is sent with, or why none can be: the detail names the starter's state, never a token. */
export type MergeToken = { ok: true; token: string } | { ok: false; detail: string };

export type MergeTokenSource = (
    who: { orgId: string; repo: RepoRef; startedBy: string | null },
    signal: AbortSignal
) => Promise<MergeToken>;

export const MERGE_STARTER_GONE = "the batch's starter no longer exists";
export const MERGE_STARTER_RECONNECT = "the batch's starter must reconnect GitHub";
export const MERGE_TOKEN_UNREAD = "the starter's GitHub token could not be read";

/**
 * Automerge merges as the batch's STARTER (docs/batches.md). With member grants that is the starter's user token; without
 * them (`AUTH_MODE=none`) the org's installation token, and no grant is read. Every answer that is not a token is
 * `{ ok: false }`: the merger leaves the task unclaimed for the pass, it never records an attempt for it.
 */
export function createMergeTokenSource(deps: {
    memberGrants: MemberForgeGrants | undefined;
    installation: () => Promise<string>;
}): MergeTokenSource {
    const { memberGrants, installation } = deps;
    return async ({ orgId, repo, startedBy }, signal) => {
        try {
            if (!memberGrants) return { ok: true, token: await installation() };
            const forge = forgeOfRepo(repo);
            if (startedBy === null) return { ok: false, detail: MERGE_STARTER_GONE };
            if (forge === null) return { ok: false, detail: MERGE_TOKEN_UNREAD };
            const member = await memberTokenOf(memberGrants, { orgId, userId: startedBy, forge }, signal);
            if (member.ok) return { ok: true, token: member.token };
            return {
                ok: false,
                detail:
                    'answer' in member && member.answer === 'waiting' ? MERGE_STARTER_RECONNECT : MERGE_TOKEN_UNREAD,
            };
        } catch {
            return { ok: false, detail: MERGE_TOKEN_UNREAD };
        }
    };
}

export function createPrTokenSource(deps: {
    memberGrants: MemberForgeGrants | undefined;
    mint: GithubMint;
}): PrTokenSource {
    const { memberGrants, mint } = deps;

    const installationToken: PrTokenSource = async ({ orgId, repo }) => {
        // The installation is GitHub's: another forge's path must never be minted for as a same-named GitHub repository.
        if (!isGithubRepo(repo)) return { ok: false, answer: 'no-forge' };
        const minted = await mint(orgId, repo.path).catch(() => undefined);
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
        return memberTokenOf(grants, { orgId, userId: executionUserId, forge }, signal);
    };

    return (who, signal) => (memberGrants ? memberToken(memberGrants, who, signal) : installationToken(who, signal));
}
