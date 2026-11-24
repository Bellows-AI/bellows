/**
 * The CLI's copy of core's repository ref (`core/src/repo-ref.ts`): the CLI imports nothing from other
 * packages, so the parser is copied and `server/test/repo-ref-parity.cli.test.ts` pins it to core's.
 */

/** The forges a repository can live on. */
export const REPO_FORGES = ['github', 'gitlab'] as const;

/** A repository's identity: the forge, the host serving it and the full path (GitLab nests groups). */
export interface RepoRef {
    readonly forge: (typeof REPO_FORGES)[number];
    readonly host: string;
    readonly path: string;
}

const GITHUB_HOST = 'github.com';
const GITHUB_REPO_PATH_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const REPO_PATH_PATTERN = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/;
const HOST_PATTERN = /^(?!\.+(:|$))[A-Za-z0-9.-]+(:[0-9]+)?$/;
const PREFIXED = /^([a-z]+):([^/]+)\/(.+)$/;

/** Reads bare `owner/name` (GitHub) or `forge:host/path`; null when malformed. Host is lowercased, path kept. */
export function parseRepoRef(text: string): RepoRef | null {
    const prefixed = PREFIXED.exec(text);
    if (!prefixed)
        return GITHUB_REPO_PATH_PATTERN.test(text) ? { forge: 'github', host: GITHUB_HOST, path: text } : null;
    const [, forge, host, path] = prefixed;
    if (!(REPO_FORGES as readonly string[]).includes(forge!) || !HOST_PATTERN.test(host!)) return null;
    const pattern = forge === 'github' ? GITHUB_REPO_PATH_PATTERN : REPO_PATH_PATTERN;
    return pattern.test(path!) ? { forge: forge as RepoRef['forge'], host: host!.toLowerCase(), path: path! } : null;
}

/** The text form: bare `owner/name` for GitHub on github.com, else `forge:host/path`. */
export const formatRepoRef = (ref: RepoRef): string =>
    ref.forge === 'github' && ref.host === GITHUB_HOST ? ref.path : `${ref.forge}:${ref.host}/${ref.path}`;
