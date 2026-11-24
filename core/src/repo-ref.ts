/** The forges a repository can live on. */
export const REPO_FORGES = ['github', 'gitlab'] as const;

/** One of {@link REPO_FORGES}. */
export type RepoForge = (typeof REPO_FORGES)[number];

/** A repository's identity: the forge, the host serving it and the full path (GitLab nests groups). */
export interface RepoRef {
    readonly forge: RepoForge;
    readonly host: string;
    readonly path: string;
}

/** GitHub's host: an identity, not a transport address, so a fake forge keeps the same identity. */
export const GITHUB_HOST = 'github.com';

/** A GitHub path: exactly owner/name. */
export const GITHUB_REPO_PATH_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** Any forge's path: two or more segments, so GitLab nested groups fit. */
export const REPO_PATH_PATTERN = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/;

/** A host with an optional port; a host of only dots (`.`, `..`) is a path traversal, not a host. */
export const HOST_PATTERN = /^(?!\.+(:|$))[A-Za-z0-9.-]+(:[0-9]+)?$/;
const PREFIXED = /^([a-z]+):([^/]+)\/(.+)$/;

/** The GitHub ref for an owner/name path on github.com. */
export const githubRepo = (path: string): RepoRef => ({ forge: 'github', host: GITHUB_HOST, path });

/** Reads bare `owner/name` (GitHub) or `forge:host/path`; null when malformed. Host is lowercased, path kept. */
export function parseRepoRef(text: string): RepoRef | null {
    const prefixed = PREFIXED.exec(text);
    if (!prefixed) return GITHUB_REPO_PATH_PATTERN.test(text) ? githubRepo(text) : null;
    const [, forge, host, path] = prefixed;
    if (!(REPO_FORGES as readonly string[]).includes(forge!) || !HOST_PATTERN.test(host!)) return null;
    const pattern = forge === 'github' ? GITHUB_REPO_PATH_PATTERN : REPO_PATH_PATTERN;
    return pattern.test(path!) ? { forge: forge as RepoForge, host: host!.toLowerCase(), path: path! } : null;
}

/** The text form: bare `owner/name` for GitHub on github.com, else `forge:host/path`. */
export const formatRepoRef = (ref: RepoRef): string =>
    ref.forge === 'github' && ref.host === GITHUB_HOST ? ref.path : `${ref.forge}:${ref.host}/${ref.path}`;

/** A string that is equal for two refs exactly when they name one repository (GitHub folds path case). */
export const repoKey = (ref: RepoRef): string =>
    `${ref.forge}:${ref.host.toLowerCase()}/${ref.forge === 'github' ? ref.path.toLowerCase() : ref.path}`;

/** Whether `a` and `b` name one repository. */
export const sameRepo = (a: RepoRef, b: RepoRef): boolean => repoKey(a) === repoKey(b);

const REPO_REF_FIELDS = ['forge', 'host', 'path'];

/**
 * Reads a wire body's `{ forge, host, path }` object: the ref (host lowercased, path kept), or the reason it is
 * refused. Unknown fields are refused, so a stale `{ owner, name }` caller hears about it.
 */
export function readRepoRef(raw: unknown): { ok: true; ref: RepoRef } | { ok: false; message: string } {
    const shape = 'repo must be {forge, host, path}';
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, message: shape };
    const fields = raw as Record<string, unknown>;
    const unknown = Object.keys(fields).find((key) => !REPO_REF_FIELDS.includes(key));
    if (unknown !== undefined) return { ok: false, message: `repo has an unknown field "${unknown}"` };
    const { forge, host, path } = fields;
    if (typeof forge !== 'string' || !(REPO_FORGES as readonly string[]).includes(forge)) {
        return { ok: false, message: `repo forge must be one of ${REPO_FORGES.join(', ')}` };
    }
    if (typeof host !== 'string' || !HOST_PATTERN.test(host)) return { ok: false, message: 'repo host is malformed' };
    const github = forge === 'github';
    if (typeof path !== 'string' || !(github ? GITHUB_REPO_PATH_PATTERN : REPO_PATH_PATTERN).test(path)) {
        return { ok: false, message: github ? 'repo path must be owner/name on GitHub' : 'repo path is malformed' };
    }
    return { ok: true, ref: { forge: forge as RepoForge, host: host.toLowerCase(), path } };
}
