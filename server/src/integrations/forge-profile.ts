/**
 * The public profile a forge reports for a member's account, kept with the member grant (docs/connections.md). GitLab's
 * `/user` fields: public data only, enough to name a commit author. Read back from jsonb, so the parse is the check.
 */
export interface ForgeProfile {
    name: string | null;
    username: string;
    commitEmail: string | null;
    publicEmail: string | null;
}

const textOrNull = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/** The profile of a stored document, or null when it is absent or not the shape (the author is then omitted). */
export function parseForgeProfile(doc: unknown): ForgeProfile | null {
    if (typeof doc !== 'object' || doc === null) return null;
    const fields = doc as Record<string, unknown>;
    const username = textOrNull(fields.username);
    if (username === null) return null;
    return {
        name: textOrNull(fields.name),
        username,
        commitEmail: textOrNull(fields.commitEmail),
        publicEmail: textOrNull(fields.publicEmail),
    };
}

/** GitLab's `/user` body as a profile; null without a username. */
export const gitlabProfileOf = (user: Record<string, unknown>): ForgeProfile | null =>
    parseForgeProfile({
        name: user.name,
        username: user.username,
        commitEmail: user.commit_email,
        publicEmail: user.public_email,
    });
