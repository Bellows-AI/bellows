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
 * The path is already tracked in the org under another forge or host. The narrow key `tracked_repo_pk (org_id, owner,
 * name)` stays until the contract migration (168_repo_ref.sql: a previous-release pod still uses it), so two refs that
 * share owner and name cannot coexist yet; the write is refused whole, naming the path, never as a raw database error.
 */
export class TrackedPathConflict extends Error {
    override readonly name = 'TrackedPathConflict';
    constructor(readonly path: string) {
        super(`${path} is already tracked in this organization under another forge or host`);
    }
}

const UNIQUE_VIOLATION = '23505';

/** The write was fenced to a connection that is no longer live: nothing was written. */
export class TrackedConnectionChanged extends Error {
    constructor() {
        super('the connection this selection was made against is no longer live');
    }
}

/**
 * Replaces the org's selection within `scope` in one transaction, leaving every other forge and host as it is. A ref
 * outside the scope throws before anything is written. With `connectionId` the write is fenced to that connection: its
 * row is locked first (the order removal takes) and must still be active and not removed, else `TrackedConnectionChanged`
 * and nothing is written, so a selection validated against a connection that was since removed (and the host perhaps
 * connected anew) never lands.
 */
export async function replaceTrackedRepos({
    sql,
    orgId,
    scope,
    repos,
    connectionId,
    ready,
}: {
    sql: Sql;
    orgId: string;
    scope: TrackedScope;
    repos: readonly RepoRef[];
    connectionId?: string | undefined;
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
    await sql
        .begin(async (tx) => {
            if (connectionId !== undefined) {
                const live = await tx`
                select 1 from forge_connection
                where org_id = ${orgId} and id = ${connectionId} and removed_at is null and active
                for update
            `;
                if (live.length === 0) throw new TrackedConnectionChanged();
            }
            // Refused before anything is deleted: another scope's row with the same owner and name holds the narrow key.
            const taken = await tx<{ path: string }[]>`
            select path from tracked_repo
            where org_id = ${orgId} and path = any(${repos.map((repo) => repo.path)}::text[])
              and not (forge = ${scope.forge} and host = ${scope.host})
            order by path
            limit 1
        `;
            if (taken[0]) throw new TrackedPathConflict(taken[0].path);
            await tx`delete from tracked_repo where org_id = ${orgId} and forge = ${scope.forge} and host = ${scope.host}`;
            // One multi-row insert, not one round trip per repo: a large App install's selection is
            // hundreds of names and this sits on the onboarding click.
            if (rows.length) await tx`insert into tracked_repo ${tx(rows)}`;
        })
        .catch((error: unknown) => {
            // A concurrent writer took the narrow key between the check and the insert: the same refusal.
            const { code, constraint_name: key } = error as { code?: string; constraint_name?: string };
            if (code === UNIQUE_VIOLATION && key === 'tracked_repo_pk')
                throw new TrackedPathConflict('a concurrently tracked path');
            throw error;
        });
}
