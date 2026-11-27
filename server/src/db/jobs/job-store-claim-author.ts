import { GITLAB_FORGE, gitlabForgeOf } from '@factory-ai/core';
import type { TransactionSql } from 'postgres';
import { type ForgeProfile, parseForgeProfile } from '../../integrations/forge-profile.js';
import { readGrantStandingRow } from '../forge-grant-standing.js';
import type { ClaimAuthor } from './job-store-types.js';

/** GitHub's private-email-safe commit address: it links the commit to the profile and leaks no mailbox. */
const NOREPLY_HOST = 'users.noreply.github.com';

/** What GitLab's `commit_email` holds for a member who chose the private commit address. */
const PRIVATE_COMMIT_EMAIL = '_private';

/** The claimed row's starter and repo forge: what picks the identity. */
export interface ClaimAuthorRow {
    run_as: string | null;
    forge: string;
    host: string;
}

/**
 * A GitLab member's commit author from the profile captured at link (docs/connections.md): the name, else the
 * username; the commit email, else the public email, else the id-qualified noreply address of the instance. The
 * member's private choice (`_private`) is the noreply address, never the public one.
 */
export function gitlabAuthorOf(profile: ForgeProfile, account: { id: string; host: string }): ClaimAuthor {
    const noreply = `${account.id}-${profile.username}@users.noreply.${account.host}`;
    const chosen =
        profile.commitEmail === PRIVATE_COMMIT_EMAIL ? noreply : (profile.commitEmail ?? profile.publicEmail);
    return { name: profile.name ?? profile.username, email: chosen ?? noreply };
}

async function gitlabAuthorFor(
    tx: TransactionSql,
    orgId: string,
    userId: string,
    host: string
): Promise<ClaimAuthor | null> {
    // One read of the one row the standing judges: no live grant, no author (the credential route owns the wait).
    const grant = await readGrantStandingRow(tx, { orgId, userId, forge: gitlabForgeOf(host) });
    const profile = parseForgeProfile(grant?.forgeProfile);
    return grant?.standing === 'live' && profile
        ? gitlabAuthorOf(profile, { id: grant.externalAccountId, host })
        : null;
}

/**
 * The commit author of a thread run by `userId`: on GitLab the member's captured profile, on GitHub the display name,
 * else login, with the id-qualified noreply address. Null for an unattributed job, an account that no longer exists or
 * a GitLab member without a live grant (the run then authors as the bot). No call leaves the database.
 */
export async function claimAuthorFor(
    tx: TransactionSql,
    orgId: string,
    row: ClaimAuthorRow
): Promise<ClaimAuthor | null> {
    const userId = row.run_as;
    if (userId === null) return null;
    if (row.forge === GITLAB_FORGE) return gitlabAuthorFor(tx, orgId, userId, row.host);
    const [user] = await tx<{ github_user_id: string; github_login: string; display_name: string | null }[]>`
        select github_user_id, github_login, display_name from app_user where id = ${userId}
    `;
    if (!user) return null;
    const name = user.display_name?.trim() || user.github_login;
    return { name, email: `${user.github_user_id}+${user.github_login}@${NOREPLY_HOST}` };
}
