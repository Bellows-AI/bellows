import { githubRepo, sameRepo, type RepoRef } from '@factory-ai/core';
import type { Repo } from '../config.js';
import { GITHUB_FORGE } from '../integrations/providers/github-user.js';

/**
 * The forges the board knows (docs/connections.md): a forge registers here once, and the gate, the claim's hold and the
 * refusal text all read it. `github` now; `gitlab:<host>` registers its own entry with its provider.
 */
interface ForgeEntry {
    /** What a member reads in a refusal. */
    label: string;
    /** The sign-in that replaces the grant, relative to the board's public origin. */
    signInPath: string;
}

const FORGES = new Map<string, ForgeEntry>([[GITHUB_FORGE, { label: 'GitHub', signInPath: '/api/auth/github' }]]);

export const forgeLabel = (forge: string): string => FORGES.get(forge)?.label ?? forge;

export const forgeSignInPath = (forge: string): string | null => FORGES.get(forge)?.signInPath ?? null;

/** Where a member reconnects the forge, relative to the board's origin: the sign-in, returning to `returnTo`. */
export const forgeConnectPath = (forge: string, who: { orgId: string; returnTo: string }): string | null => {
    const signInPath = forgeSignInPath(forge);
    return signInPath === null
        ? null
        : `${signInPath}?${new URLSearchParams({ returnTo: who.returnTo, org: who.orgId })}`;
};

/** The forge a repo lives on; null for a task with no repo, which needs no grant. Every repo is GitHub's for now. */
export const forgeOfRepo = (repo: string | null): string | null => (repo === null ? null : GITHUB_FORGE);

/** Whether the GitHub reader answers for this repository: GitHub on github.com, the only host it is wired to. */
export const isGithubRepo = (repo: RepoRef): boolean => sameRepo(githubRepo(repo.path), repo);

/** The ref of a wire `owner/name`, the edge into the stores: GitHub's until a route carries a forge; null for none. */
export const repoRefOf = (repo: string | null): RepoRef | null => (repo === null ? null : githubRepo(repo));

/** The ref of a listed repo: the one place the GitHub-only listing becomes refs, until a mixed-forge source replaces it. */
export const refOfListed = (repo: Repo): RepoRef => githubRepo(`${repo.owner}/${repo.name}`);
