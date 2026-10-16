import { READ_BINDING, READ_FORBIDDEN, READ_NOT_FOUND } from '@factory-ai/core';
import { GitHubReadError, type ApiCall } from './pr-read.js';

/**
 * One repository file at one commit, through the installation (docs/jobs.md, "the execution
 * plan"): the branch's tip is resolved to a sha first and the file is read AT that sha, so the
 * answer names the exact revision it was read from.
 */
export interface RepoFileRead {
    /** The commit the file was read at. */
    readonly revision: string;
    /** The file's text; null when the commit has no such file. */
    readonly text: string | null;
}

/** Past this a file is refused unread: the contents API inlines at most 1 MiB, and a plan file is never near it. */
const MAX_FILE_BYTES = 65_536;

const BASE64 = 'base64';

/** A branch name or the default branch (`null` → `HEAD`) as a path segment of the commits API. */
const DEFAULT_BRANCH_REF = 'HEAD';

interface CommitPayload {
    sha?: string;
}

interface ContentsPayload {
    type?: string;
    size?: number;
    encoding?: string;
    content?: string;
}

/**
 * `repo`'s `path` at the tip of `branch` (the default branch when null). Null when the repository
 * or the branch is invisible to the installation; a `GitHubReadError` for a rate limit or a dropped
 * connection, which say nothing about the repository and must be retried, never read as "no file".
 */
export async function readRepoFileAtBranchTip(
    call: ApiCall,
    repo: string,
    branch: string | null,
    path: string
): Promise<RepoFileRead | null> {
    const commit = await optionalRead(
        call,
        `/repos/${repo}/commits/${encodeURIComponent(branch ?? DEFAULT_BRANCH_REF)}`
    );
    const revision = (commit as CommitPayload | null)?.sha;
    if (!revision) return null;
    // Only "not found" is an absent file: a forbidden contents read is a missing App permission,
    // and answering "no file" for it would drop the repository's gates without a word.
    const body = (await optionalRead(call, `/repos/${repo}/contents/${path}?ref=${revision}`, [
        READ_NOT_FOUND,
    ])) as ContentsPayload | null;
    if (body === null) return { revision, text: null };
    if (body.type !== 'file' || body.encoding !== BASE64 || typeof body.content !== 'string') {
        throw new GitHubReadError(`${path} is not a regular file at ${revision}`, READ_BINDING);
    }
    if ((body.size ?? 0) > MAX_FILE_BYTES) {
        throw new GitHubReadError(`${path} is larger than ${MAX_FILE_BYTES} bytes`, READ_BINDING);
    }
    return { revision, text: Buffer.from(body.content, BASE64).toString('utf8') };
}

async function optionalRead(
    call: ApiCall,
    path: string,
    absent: readonly string[] = [READ_NOT_FOUND, READ_FORBIDDEN]
): Promise<unknown> {
    try {
        return await call(path);
    } catch (e) {
        if (e instanceof GitHubReadError && absent.includes(e.kind)) return null;
        throw e;
    }
}
