import { formatRepoRef, gitlabHostOf, type RepoRef } from '@factory-ai/core';
import type { ForgeConnectionStore } from '../db/forge-connections.js';
import { GITLAB_DEVELOPER_LEVEL, type GitlabApi } from '../gitlab/gitlab-api.js';
import type { MemberForgeGrants } from '../integrations/member-forge-grant.js';
import { forgeConnectPath, forgeOfRepo } from './forges.js';

/**
 * The forge start gate (docs/connections.md): no run starts or continues on a repo unless the acting member holds a
 * live grant for the repo's forge, and, on GitLab, the instance says they hold Developer or more on the project (the
 * maximum of their project and group access, read with their own token). Every entry point asks the same question. A
 * read that cannot be confirmed, a standing or the access check, throws: the caller answers 503, never a refusal.
 */

/** `no-access`: the grant is live but the forge says the member may not work on this repository. */
export type ForgeStanding = 'missing' | 'broken' | 'no-access';

export type ForgeVerdict =
    | { ok: true }
    | { ok: false; forge: string; standing: ForgeStanding; connectUrl: string; repo?: string };

/** The GitLab half of the gate: the org's connection (its CA bundle) and the client the access check is made through. */
export interface GitlabAccess {
    connectionsOf(orgId: string): Promise<ForgeConnectionStore | undefined>;
    api: GitlabApi;
}

const ACCESS_DEADLINE_MS = 30_000;

export interface ForgeGate {
    /** Throws on a standing read it could not confirm. */
    check(who: { orgId: string; userId: string; repo: RepoRef | null; returnTo: string }): Promise<ForgeVerdict>;
}

type Who = Parameters<ForgeGate['check']>[0];

/** The member's own access to a GitLab project: a verdict, or a throw when the instance did not confirm either way. */
async function gitlabVerdict(
    deps: { memberGrants: MemberForgeGrants; gitlab: GitlabAccess; publicUrl: string },
    who: Who & { repo: RepoRef },
    forge: string
): Promise<ForgeVerdict> {
    const { orgId, userId, repo, returnTo } = who;
    const host = gitlabHostOf(forge) as string;
    const refused = (standing: ForgeStanding): ForgeVerdict => ({
        ok: false,
        forge,
        standing,
        connectUrl: `${deps.publicUrl}${forgeConnectPath(forge, { orgId, returnTo })}`,
        repo: formatRepoRef(repo),
    });
    const application = await (await deps.gitlab.connectionsOf(orgId))?.application(host);
    if (!application?.active) return refused('missing');
    const signal = AbortSignal.timeout(ACCESS_DEADLINE_MS);
    const token = await deps.memberGrants.accessToken(orgId, userId, forge, { signal });
    if (!token.ok) {
        if (token.outcome.outcome !== 'integration_required') throw new Error('the member token is not confirmed');
        return refused(token.outcome.reason === 'missing' ? 'missing' : 'broken');
    }
    const access = await deps.gitlab.api.projectAccess({
        host,
        token: token.accessToken,
        caBundle: application.caBundle,
        project: repo.path,
        signal,
    });
    if (!access.ok) throw new Error('the project access is not confirmed');
    return access.level >= GITLAB_DEVELOPER_LEVEL ? { ok: true } : refused('no-access');
}

/** Absent when there is no grant store to read (AUTH_MODE=none): the run acts as the App, so nothing is gated. */
export function createForgeGate(deps: {
    memberGrants: MemberForgeGrants | undefined;
    publicUrl: string;
    gitlab?: GitlabAccess | undefined;
}): ForgeGate | undefined {
    const { memberGrants, publicUrl, gitlab } = deps;
    if (!memberGrants) return undefined;
    return {
        async check(who) {
            const { orgId, userId, repo, returnTo } = who;
            const forge = forgeOfRepo(repo);
            const path = forge === null ? null : forgeConnectPath(forge, { orgId, returnTo });
            if (forge === null || path === null) return { ok: true };
            const standing = await memberGrants.standing(orgId, userId, forge);
            if (standing !== 'live') return { ok: false, forge, standing, connectUrl: `${publicUrl}${path}` };
            if (gitlab === undefined || repo === null || gitlabHostOf(forge) === null) return { ok: true };
            return gitlabVerdict({ memberGrants, gitlab, publicUrl }, { ...who, repo }, forge);
        },
    };
}
