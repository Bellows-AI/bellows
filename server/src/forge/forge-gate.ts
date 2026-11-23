import type { MemberForgeGrants } from '../integrations/member-forge-grant.js';
import { forgeOfRepo, forgeSignInPath } from './forges.js';

/**
 * The forge start gate (docs/connections.md): no run starts or continues on a repo unless the acting member holds a
 * live grant for the repo's forge. A forge registers here once (`github` now, `gitlab:<host>` with its provider), and
 * every entry point asks the same question. A standing read that cannot be confirmed throws: the caller answers 503,
 * never a refusal.
 */

export type ForgeStanding = 'missing' | 'broken';

export type ForgeVerdict = { ok: true } | { ok: false; forge: string; standing: ForgeStanding; connectUrl: string };

export interface ForgeGate {
    /** Throws on a standing read it could not confirm. */
    check(who: { orgId: string; userId: string; repo: string | null; returnTo: string }): Promise<ForgeVerdict>;
}

/** Absent when there is no grant store to read (AUTH_MODE=none): the run acts as the App, so nothing is gated. */
export function createForgeGate(deps: {
    memberGrants: MemberForgeGrants | undefined;
    publicUrl: string;
}): ForgeGate | undefined {
    const { memberGrants, publicUrl } = deps;
    if (!memberGrants) return undefined;
    return {
        async check({ orgId, userId, repo, returnTo }) {
            const forge = forgeOfRepo(repo);
            const signInPath = forge === null ? null : forgeSignInPath(forge);
            if (forge === null || signInPath === null) return { ok: true };
            const standing = await memberGrants.standing(orgId, userId, forge);
            if (standing === 'live') return { ok: true };
            const query = new URLSearchParams({ returnTo, org: orgId });
            return { ok: false, forge, standing, connectUrl: `${publicUrl}${signInPath}?${query}` };
        },
    };
}
