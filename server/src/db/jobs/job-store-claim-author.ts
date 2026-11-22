import type { TransactionSql } from 'postgres';
import type { ClaimAuthor } from './job-store-types.js';

/** GitHub's private-email-safe commit address: it links the commit to the profile and leaks no mailbox. */
const NOREPLY_HOST = 'users.noreply.github.com';

/**
 * The commit author of a thread run by `userId`: display name, else GitHub login, with the id-qualified noreply
 * address. Null for an unattributed job or an account that no longer exists (the run then authors as the bot).
 */
export async function claimAuthorFor(tx: TransactionSql, userId: string | null): Promise<ClaimAuthor | null> {
    if (userId === null) return null;
    const [user] = await tx<{ github_user_id: string; github_login: string; display_name: string | null }[]>`
        select github_user_id, github_login, display_name from app_user where id = ${userId}
    `;
    if (!user) return null;
    const name = user.display_name?.trim() || user.github_login;
    return { name, email: `${user.github_user_id}+${user.github_login}@${NOREPLY_HOST}` };
}
