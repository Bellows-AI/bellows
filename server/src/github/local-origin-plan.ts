import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { BELLOWS_FILE, createPlanReader, type PlanRead, type PlanReader } from '../workspace/bellows-plan.js';
import { READ_BINDING, READ_TRANSPORT } from '@factory-ai/core';
import { MAX_FILE_BYTES, type RepoFileRead } from './file-read.js';
import { GitHubReadError } from './pr-read.js';

const run = promisify(execFile);

/** Where the offline board finds its bare mirrors: `<workspace root>/.origins/<owner>/<name>.git`. */
export const LOCAL_ORIGINS_DIR = '.origins';

/** `owner/name`, each a plain path segment — a label never resolves outside the origins dir. */
const REPO_LABEL = /^(?!\.{1,2}\/)[A-Za-z0-9_.-]+\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;

const unplanned = (error: string | null): PlanRead => ({
    config: null,
    services: [],
    policy: {},
    reviewers: [],
    revision: null,
    error,
});

/** Whether `path` exists: only a missing path is absence — a permission error or a symlink loop is the outage. */
const exists = (path: string) =>
    stat(path).then(
        () => true,
        (e: NodeJS.ErrnoException) => {
            if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false;
            throw new GitHubReadError(`${path}: ${e.message}`, READ_TRANSPORT);
        }
    );

/**
 * `git` against the bare repository at `gitDir`: its stdout, or null when it exits 1 (`symbolic-ref -q`
 * on a HEAD that names no branch). Any other failure is an outage, never an absence.
 */
async function git(gitDir: string, args: string[]): Promise<string | null> {
    try {
        return (await run('git', ['--git-dir', gitDir, ...args])).stdout;
    } catch (e) {
        if ((e as { code?: unknown }).code === 1) return null;
        throw new GitHubReadError(`git ${args[0]} in ${gitDir}: ${(e as Error).message}`, READ_TRANSPORT);
    }
}

/** The commit at the tip of `branch` (the default branch when null) — an exact branch ref, never a revision expression. */
async function tipOf(gitDir: string, branch: string | null): Promise<string | null> {
    const ref = branch ? `refs/heads/${branch}` : (await git(gitDir, ['symbolic-ref', '-q', 'HEAD']))?.trim();
    if (!ref) return null;
    // Exits 0 whether or not the ref exists; a pattern can match more, so only the exact name counts.
    const refs = (await git(gitDir, ['for-each-ref', '--format=%(refname) %(objectname)', ref])) ?? '';
    const line = refs.split('\n').find((entry) => entry.startsWith(`${ref} `));
    return line ? line.slice(ref.length + 1) : null;
}

/** `readFileAtBranchTip` over a local bare repository, in the shape the App client answers it. */
async function readAtBranchTip(gitDir: string, branch: string | null, path: string): Promise<RepoFileRead | null> {
    const revision = await tipOf(gitDir, branch);
    if (!revision) return null;
    // `<mode> <type> <oid> <size>\t<path>`, or nothing at all for a path the commit does not have.
    const entry = (await git(gitDir, ['ls-tree', '-l', revision, '--', path]))?.trim();
    if (!entry) return { revision, text: null };
    const [, type, oid, size] = entry.split(/\s+/);
    if (type !== 'blob' || !oid) throw new GitHubReadError(`${path} is not a file`, READ_BINDING);
    if (Number(size) > MAX_FILE_BYTES)
        throw new GitHubReadError(`${path} is larger than ${MAX_FILE_BYTES} bytes`, READ_BINDING);
    return { revision, text: (await git(gitDir, ['cat-file', 'blob', oid])) ?? '' };
}

/**
 * The offline board's plan source (the code-only `none` arm, which has no App client): a
 * repository's plan read from its bare mirror under `dir`, through the same validation and refusals
 * the App path uses. A repository nothing mirrored carries no plan, as it did before this reader.
 */
export function createLocalPlanReader(dir: string): PlanReader {
    return {
        async read(repo, baseBranch) {
            if (!REPO_LABEL.test(repo)) return unplanned(`${BELLOWS_FILE} of ${repo}: not an owner/name repository`);
            const gitDir = join(dir, `${repo}.git`);
            if (!(await exists(gitDir))) return unplanned(null);
            return createPlanReader({
                readFileAtBranchTip: (_repo, branch, path) => readAtBranchTip(gitDir, branch, path),
            }).read(repo, baseBranch);
        },
    };
}
