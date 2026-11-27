import { formatRepoRef, type RepoRef } from '@factory-ai/core';
import type { MemberForgeGrants } from '../integrations/member-forge-grant.js';
import {
    INSTALLATION_CREDENTIAL,
    resolveForgeClient,
    type ActingCredential,
    type ForgeClient,
    type ForgeSource,
} from './forge-client.js';
import type { GitlabAccess } from './forge-gate.js';
import { forgeOfRepo, isGitlabRepo } from './forges.js';
import { gitlabRequest } from './gitlab-call.js';
import { readDefaultBranch } from './gitlab-reads.js';
import { MERGE_STARTER_GONE, memberTokenOf } from './pr-token.js';

/**
 * How the board reads a repository as somebody (docs/batches.md): GitHub through the org's installation, GitLab as the
 * acting member, whose grant is read for the one read and whose connection supplies the CA bundle. A grant, a
 * connection or a starter the board cannot confirm is `unconfirmed`: no request is made and the caller keeps whatever it
 * last knew, never a verdict about the change request.
 */

/** What the board reads GitLab through: the org's connection, the board's client and the members' grants. */
export interface GitlabReads {
    gitlab: GitlabAccess;
    memberGrants: MemberForgeGrants;
}

/** `binding`: no client answers for the repository here. `unconfirmed`: one does, but the acting grant is unread. */
export interface Unread {
    ok: false;
    kind: 'binding' | 'unconfirmed';
    detail: string;
}

export type ReadClient = { ok: true; client: ForgeClient } | Unread;

export interface ReadDeps {
    forge?: ForgeSource | undefined;
    gitlab?: GitlabReads | undefined;
    orgId: string;
}

export const GITLAB_STARTER_RECONNECT = 'the starter must reconnect GitLab';
const GITLAB_TOKEN_UNREAD = "the starter's GitLab token could not be read";

/** Rejects when `signal` aborts, so a read that takes no signal still ends with the call's one deadline. */
export function within<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const aborted = () => reject(new Error('no answer before the deadline'));
        if (signal.aborted) return aborted();
        signal.addEventListener('abort', aborted, { once: true });
        work.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
    });
}

/**
 * The source a GitLab call is made through. It is built per call with the CA bundle of the org's connection on the repo's
 * host and `signal` as the call's one deadline; a connection that cannot be read, or is not active, is a throw: never a
 * verdict.
 */
export async function sourceOf(
    deps: { forge: ForgeSource; gitlab?: GitlabAccess | undefined },
    orgId: string,
    repo: RepoRef,
    signal: AbortSignal
): Promise<ForgeSource> {
    if (!isGitlabRepo(repo) || deps.gitlab === undefined) return deps.forge;
    const connections = await within(deps.gitlab.connectionsOf(orgId), signal);
    if (!connections) throw new Error('the GitLab connection store is not available');
    const application = await within(connections.application(repo.host), signal);
    if (!application?.active) throw new Error('the GitLab connection is not active');
    return { ...deps.forge, gitlab: { api: deps.gitlab.api, caBundle: application.caBundle, signal } };
}

const notGitlabReader = (repo: RepoRef): Unread => ({
    ok: false,
    kind: 'binding',
    detail: `${formatRepoRef(repo)} is not a repository the GitLab reader answers for`,
});

const unconfirmed = (detail: string): Unread => ({ ok: false, kind: 'unconfirmed', detail });

/** The starter's confirmed GitLab token and the source it is used through, or why neither is known. */
async function gitlabActing(
    deps: ReadDeps & { gitlab: GitlabReads },
    repo: RepoRef,
    actor: string | null,
    signal: AbortSignal
): Promise<{ ok: true; token: string; source: ForgeSource } | Unread> {
    if (actor === null) return unconfirmed(MERGE_STARTER_GONE);
    const { gitlab, memberGrants } = deps.gitlab;
    const forge = forgeOfRepo(repo) as string;
    try {
        const source = await sourceOf({ forge: {}, gitlab }, deps.orgId, repo, signal);
        const member = await memberTokenOf(memberGrants, { orgId: deps.orgId, userId: actor, forge }, signal);
        if (member.ok) return { ok: true, token: member.token, source };
        const reconnect = 'answer' in member && member.answer === 'waiting';
        return unconfirmed(reconnect ? GITLAB_STARTER_RECONNECT : GITLAB_TOKEN_UNREAD);
    } catch (e) {
        return unconfirmed(`${formatRepoRef(repo)} cannot be read as the starter: ${(e as Error).message}`);
    }
}

const githubClient = (deps: ReadDeps, repo: RepoRef, credential: ActingCredential): ReadClient => {
    const resolution = resolveForgeClient(deps.forge, repo, credential);
    return resolution.ok
        ? { ok: true, client: resolution.client }
        : {
              ok: false,
              kind: 'binding',
              detail: `${formatRepoRef(repo)} is not a repository the GitHub reader answers for`,
          };
};

const gitlabClient = (source: ForgeSource, repo: RepoRef, token: string): ReadClient => {
    const resolution = resolveForgeClient(source, repo, { kind: 'token', token });
    return resolution.ok
        ? { ok: true, client: resolution.client }
        : { ok: false, kind: 'binding', detail: `no client answers for ${resolution.forge} repositories` };
};

/**
 * The client a change request of `repo` is read through. GitHub: the installation's. GitLab: the acting member's own
 * token (`actor`, the task's starter), refused as `unconfirmed` with no request when there is no starter, no active
 * connection or no live grant, and as `binding` on a board with no GitLab access at all (AUTH_MODE=none).
 */
export async function readClient(
    deps: ReadDeps,
    repo: RepoRef,
    actor: string | null,
    signal: AbortSignal
): Promise<ReadClient> {
    if (!isGitlabRepo(repo)) return githubClient(deps, repo, INSTALLATION_CREDENTIAL);
    if (deps.gitlab === undefined) return notGitlabReader(repo);
    const acting = await gitlabActing({ ...deps, gitlab: deps.gitlab }, repo, actor, signal);
    return acting.ok ? gitlabClient(acting.source, repo, acting.token) : acting;
}

/**
 * The client a merge is sent through, acting with a `token` the caller already read (the batch starter's). The same
 * boundary as `readClient`: `signal` is the one deadline of the merge, and a connection that cannot be read is `unconfirmed`.
 */
export async function tokenClient(
    deps: ReadDeps,
    repo: RepoRef,
    token: string,
    signal: AbortSignal
): Promise<ReadClient> {
    if (!isGitlabRepo(repo)) return githubClient(deps, repo, { kind: 'token', token });
    if (deps.gitlab === undefined) return notGitlabReader(repo);
    try {
        const source = await sourceOf({ forge: {}, gitlab: deps.gitlab.gitlab }, deps.orgId, repo, signal);
        return gitlabClient(source, repo, token);
    } catch (e) {
        return unconfirmed(`${formatRepoRef(repo)} cannot be merged: ${(e as Error).message}`);
    }
}

/** The default branch answered for, or null for a confirmed empty project. */
export type DefaultBranchRead = { ok: true; branch: string | null } | Unread;

/**
 * A GitLab project's default branch as the acting member, at launch. A read that does not confirm throws; a project the
 * instance confirms has none is `{ ok: true, branch: null }`.
 */
export async function readGitlabDefaultBranch(
    deps: ReadDeps,
    repo: RepoRef,
    actor: string | null,
    signal: AbortSignal
): Promise<DefaultBranchRead> {
    if (deps.gitlab === undefined) return notGitlabReader(repo);
    const acting = await gitlabActing({ ...deps, gitlab: deps.gitlab }, repo, actor, signal);
    if (!acting.ok) return acting;
    if (acting.source.gitlab === undefined) return notGitlabReader(repo);
    const call = gitlabRequest(acting.source.gitlab, repo, acting.token);
    return { ok: true, branch: await readDefaultBranch(call, repo, signal) };
}
