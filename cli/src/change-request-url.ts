/**
 * The CLI's copy of core's change-request URL parser (`core/src/change-request-url.ts`): it imports nothing from
 * other packages, so the parser is copied and `server/test/change-request-url-parity.test.ts` pins it to core's.
 */
import { parseRepoRef, type RepoRef } from './repo-ref.js';

/** A change request's identity: the repository it is on and its number (GitHub PR number, GitLab MR iid). */
export interface ChangeRequestRef {
    readonly ref: RepoRef;
    readonly number: number;
}

const GITHUB_PULL = /^\/([^/]+\/[^/]+)\/pull\/([^/]+)\/?$/;
const GITLAB_MERGE_REQUEST = /^\/(.+)\/-\/merge_requests\/([^/]+)\/?$/;
const NUMBER_TEXT = /^[1-9][0-9]*$/;
const HTTPS_URL = /^https:\/\/([A-Za-z0-9.:-]+)(\/[A-Za-z0-9._\/-]*)$/;

const isNumber = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

/** The ref for a URL's parts, or null when its host or path is not a repository's. */
function repoOf(forge: RepoRef['forge'], host: string, path: string): RepoRef | null {
    if (path.split('/').some((segment) => segment === '.' || segment === '..' || segment === '-')) return null;
    return parseRepoRef(`${forge}:${host.toLowerCase()}/${path}`);
}

/**
 * Reads a change-request URL: `https://<host>/<owner>/<name>/pull/<n>` (GitHub) or
 * `https://<host>/<group>/.../<name>/-/merge_requests/<iid>` (GitLab, any nesting, host with optional port).
 * Null for anything else: other schemes, credentials, a query or fragment, a suffix such as `/files`, or a number
 * that is not a positive safe integer. Whether the forge is supported is the caller's question, not the parser's.
 */
export function parseChangeRequestUrl(text: string): ChangeRequestRef | null {
    const url = HTTPS_URL.exec(text);
    if (!url) return null;
    const [, host, pathname] = url;
    const github = GITHUB_PULL.exec(pathname!);
    const gitlab = github ? null : GITLAB_MERGE_REQUEST.exec(pathname!);
    const match = github ?? gitlab;
    if (!match || !NUMBER_TEXT.test(match[2]!)) return null;
    const number = Number(match[2]);
    if (!isNumber(number)) return null;
    const ref = repoOf(github ? 'github' : 'gitlab', host!, match[1]!);
    return ref ? { ref, number } : null;
}

/** The URL {@link parseChangeRequestUrl} reads back to `ref` and `number`; throws on a number it would refuse. */
export function formatChangeRequestUrl(ref: RepoRef, number: number): string {
    if (!isNumber(number)) throw new RangeError(`a change request number is a positive safe integer, got ${number}`);
    const tail = ref.forge === 'github' ? `pull/${number}` : `-/merge_requests/${number}`;
    return `https://${ref.host}/${ref.path}/${tail}`;
}
