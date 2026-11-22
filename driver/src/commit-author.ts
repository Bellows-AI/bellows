/**
 * The member who authors a task's commits. The board names them in the claim (`author`: display name and
 * GitHub noreply address); the committer stays the bot, which every image's gitconfig and the publish fallback
 * supply. Copied from the board's `ClaimAuthor`, never imported. A name and a public address, never a credential.
 */
export interface CommitAuthor {
    name: string;
    email: string;
}

/** Env names git reads for the author alone: setting them leaves the committer, and so the bot, untouched. */
export const AUTHOR_NAME_ENV = 'GIT_AUTHOR_NAME';
export const AUTHOR_EMAIL_ENV = 'GIT_AUTHOR_EMAIL';

/** The first printable character: anything below it (newline, NUL) cannot ride env or a git ident. */
const SPACE = 0x20;

/** A claim's `author` as a usable value, or null: a malformed or control-character one reads as no author. */
export function commitAuthorOf(value: unknown): CommitAuthor | null {
    if (typeof value !== 'object' || value === null) return null;
    const { name, email } = value as Record<string, unknown>;
    const usable = (text: unknown): text is string =>
        typeof text === 'string' && text.trim() !== '' && ![...text].some((char) => char.charCodeAt(0) < SPACE);
    return usable(name) && usable(email) ? { name, email } : null;
}

/** The author as env pairs for any process that may commit: the agent container and the publish commit. */
export function authorEnv(job: { author?: CommitAuthor | undefined }): [string, string][] {
    return job.author
        ? [
              [AUTHOR_NAME_ENV, job.author.name],
              [AUTHOR_EMAIL_ENV, job.author.email],
          ]
        : [];
}
