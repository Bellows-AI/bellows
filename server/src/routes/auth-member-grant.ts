import type { FastifyRequest } from 'fastify';
import type { GitHubIdentity, GitHubUserTokens } from '../auth/github.js';
import type { Caller } from '../auth/store.js';
import type { MemberForgeGrants } from '../integrations/member-forge-grant.js';
import { GITHUB_FORGE } from '../integrations/providers/github-user.js';

/**
 * What the sign-in does with the App user token pair it obtained (docs/auth.md): after the member and the org exist,
 * hand it to the member's GitHub grant. Split out of `auth.ts` to keep that file under the repo's line-count ceiling.
 */

/**
 * Keeps the pair as the member's grant in the org the session is for. A grant that cannot be stored never blocks the
 * sign-in: the member signs in without one, and the next sign-in replaces it. Logs the reason, never a token.
 */
export async function keepMemberGrant(
    grants: MemberForgeGrants | undefined,
    request: FastifyRequest,
    signedIn: { caller: Caller; who: GitHubIdentity; tokens: GitHubUserTokens }
): Promise<void> {
    if (!grants) return;
    const { caller, who, tokens } = signedIn;
    try {
        const stored = await grants.store({
            orgId: caller.org.id,
            userId: caller.user.id,
            forge: GITHUB_FORGE,
            externalAccountId: String(who.githubUserId),
            tokens: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresIn: tokens.expiresIn },
        });
        if (!stored.ok) request.log.warn({ reason: stored.reason }, 'the member GitHub grant was not stored');
    } catch (err) {
        request.log.error({ err }, 'the member GitHub grant could not be stored');
    }
}

/**
 * Where a completed onboarding goes next. The parked sign-in dropped its token pair (no member existed to key a grant
 * on), so the completion sends the browser round the authorize trip again — silent, with the selection now stored —
 * which signs in and keeps the grant. Without a grant store there is nothing to keep and the destination stands.
 */
export function afterOnboarding(grants: MemberForgeGrants | undefined, returnTo: string, orgId: string): string {
    return grants ? `/api/auth/github?${new URLSearchParams({ returnTo, org: orgId })}` : returnTo;
}
