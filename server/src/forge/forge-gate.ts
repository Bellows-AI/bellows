import type { MemberForgeGrants } from '../integrations/member-forge-grant.js';
import { GITHUB_FORGE } from '../integrations/providers/github-user.js';

/**
 * The forge start gate (docs/connections.md): no run starts or continues on a repo unless the acting member holds a
 * live grant for the repo's forge. A forge registers here once (`github` now, `gitlab:<host>` with its provider), and
 * every entry point asks the same question. A standing read that cannot be confirmed throws: the caller answers 503,
 * never a refusal.
 */

interface ForgeEntry {
    /** What a member reads in a refusal. */
    label: string;
    /** The sign-in that replaces the grant, relative to the board's public origin. */
    signInPath: string;
}

const FORGES = new Map<string, ForgeEntry>([[GITHUB_FORGE, { label: 'GitHub', signInPath: '/api/auth/github' }]]);

export const forgeLabel = (forge: string): string => FORGES.get(forge)?.label ?? forge;

/** The forge a repo lives on; null for a task with no repo, which needs no grant. Every repo is GitHub's for now. */
export const forgeOfRepo = (repo: string | null): string | null => (repo === null ? null : GITHUB_FORGE);

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
            const entry = forge === null ? undefined : FORGES.get(forge);
            if (forge === null || !entry) return { ok: true };
            const standing = await memberGrants.standing(orgId, userId, forge);
            if (standing === 'live') return { ok: true };
            const query = new URLSearchParams({ returnTo, org: orgId });
            return { ok: false, forge, standing, connectUrl: `${publicUrl}${entry.signInPath}?${query}` };
        },
    };
}
