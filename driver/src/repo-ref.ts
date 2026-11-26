/**
 * The driver's copy of core's repository ref (`core/src/repo-ref.ts`): the driver imports nothing from
 * other packages, so the shape is copied and `server/test/repo-ref.driver-copy.test.ts` pins it to core's.
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

/** Whether a wire value is a well-formed ref: a known forge, a host, and the forge's own path shape. */
export function isRepoRef(value: unknown): value is RepoRef {
    if (typeof value !== 'object' || value === null) return false;
    const { forge, host, path } = value as Record<string, unknown>;
    if (typeof forge !== 'string' || typeof host !== 'string' || typeof path !== 'string') return false;
    if (!(REPO_FORGES as readonly string[]).includes(forge) || !HOST_PATTERN.test(host)) return false;
    return (forge === 'github' ? GITHUB_REPO_PATH_PATTERN : REPO_PATH_PATTERN).test(path);
}

/** The text form: bare `owner/name` for GitHub on github.com, else `forge:host/path`. */
export const formatRepoRef = (ref: RepoRef): string =>
    ref.forge === 'github' && ref.host === GITHUB_HOST ? ref.path : `${ref.forge}:${ref.host}/${ref.path}`;

/**
 * Whether the job's git reaches its forge through the supervisor's mailbox (`StepRequest.forgeHost`): a GitLab
 * repository, whose member token is fetched on demand by the step's own git and never rides a step or claim env.
 */
export const usesForgeMailbox = (job: { repo?: RepoRef | null | undefined }): boolean => job.repo?.forge === 'gitlab';

/**
 * Why this driver cannot clone `ref`, or null when it can. A GitLab host is the board's to decide (it claims only
 * connected ones, and the mailbox fetches the token); GitHub is served on github.com only, so every other
 * GitHub host is refused before any sync or token request.
 */
export function cloneHostRefusal(ref: RepoRef): string | null {
    if (ref.forge === 'gitlab') return null;
    if (ref.host.toLowerCase() === GITHUB_HOST) return null;
    return `This job names repository ${ref.forge}:${ref.host}/${ref.path}, but this driver holds no git credential for that host, so nothing was cloned.`;
}
