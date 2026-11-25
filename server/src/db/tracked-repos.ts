import { GITHUB_HOST, REPO_FORGES, REPO_PATH_PATTERN, type RepoForge, type RepoRef } from '@factory-ai/core';
import type { Sql } from 'postgres';
import { GITHUB_FORGE } from '../integrations/providers/github-user.js';

/**
 * The org's tracked-repo allowlist — the onboarding screen's per-org checkbox answer.
 *
 * No GitHub rows means the org tracks EVERYTHING its installation reports: the default, and the reason a
 * confirm-with-everything-checked writes nothing. GitLab rows are an explicit selection per host and never widen or
 * narrow GitHub's: every write replaces one forge-and-host scope (`TrackedScope`) and leaves the others alone. The org's repo source intersects its
 * installation listing with this table (see repo-source.ts), so stats scoping and the
 * workspace/env writes all follow one truth.
 */

/** The forge and host one selection covers: GitHub's, or one GitLab instance's. */
export type TrackedScope = Pick<RepoRef, 'forge' | 'host'>;

export const GITHUB_SCOPE: TrackedScope = { forge: GITHUB_FORGE, host: GITHUB_HOST };

const isForge = (forge: string): forge is RepoForge => (REPO_FORGES as readonly string[]).includes(forge);

/**
 * The org's allowlist as refs (every forge, or `scope`'s only), ordered by path. A row that is not a well-formed ref
 * throws: dropping it could leave `[]`, which the repo source reads as "track everything" — a widening on a bad read.
 */
export async function trackedRepos({
    sql,
    orgId,
    scope,
    ready,
}: {
    sql: Sql;
    orgId: string;
    scope?: TrackedScope;
    ready?: Promise<unknown>;
}): Promise<RepoRef[]> {
    if (ready) await ready;
    const rows = await sql<{ forge: string; host: string; path: string }[]>`
        select forge, host, path from tracked_repo
        where org_id = ${orgId}
          ${scope ? sql`and forge = ${scope.forge} and host = ${scope.host}` : sql``}
        order by forge, host, path
    `;
    return rows.map(({ forge, host, path }) => {
        if (!isForge(forge) || host === '' || !REPO_PATH_PATTERN.test(path)) {
            throw new Error('tracked_repo holds a row that is not a repository reference');
        }
        return { forge, host, path };
    });
}

/**
 * Replaces the org's selection within `scope` in one transaction, leaving every other forge and host as it is. A ref
 * outside the scope throws before anything is written.
 */
export async function replaceTrackedRepos({
    sql,
    orgId,
    scope,
    repos,
    ready,
}: {
    sql: Sql;
    orgId: string;
    scope: TrackedScope;
    repos: readonly RepoRef[];
    ready?: Promise<unknown>;
}): Promise<void> {
    if (ready) await ready;
    // The path splits at its last "/": the owner column holds the group chain, the name column the project. `path` is
    // generated from the two.
    const rows = repos.map(({ forge, host, path }) => {
        if (forge !== scope.forge || host !== scope.host) throw new Error('a tracked repository is outside its scope');
        const slash = path.lastIndexOf('/');
        if (slash <= 0 || slash === path.length - 1) throw new Error('a tracked repository path is group/name');
        return { org_id: orgId, forge, host, owner: path.slice(0, slash), name: path.slice(slash + 1) };
    });
    await sql.begin(async (tx) => {
        await tx`delete from tracked_repo where org_id = ${orgId} and forge = ${scope.forge} and host = ${scope.host}`;
        // One multi-row insert, not one round trip per repo: a large App install's selection is
        // hundreds of names and this sits on the onboarding click.
        if (rows.length) await tx`insert into tracked_repo ${tx(rows)}`;
    });
}
