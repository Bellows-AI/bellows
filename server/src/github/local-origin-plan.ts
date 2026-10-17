import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { BELLOWS_FILE, createPlanReader, type PlanRead, type PlanReader } from '../workspace/bellows-plan.js';
import { READ_BINDING } from '@factory-ai/core';
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

const exists = (path: string) =>
    stat(path).then(
        () => true,
        () => false
    );

/** The commit `ref` names in the bare repository at `gitDir`, or null when it names none. */
async function commitOf(gitDir: string, ref: string): Promise<string | null> {
    try {
        const { stdout } = await run('git', [
            '--git-dir',
            gitDir,
            'rev-parse',
            '--verify',
            '--quiet',
            `${ref}^{commit}`,
        ]);
        return stdout.trim() || null;
    } catch {
        return null;
    }
}

/** `readFileAtBranchTip` over a local bare repository, in the shape the App client answers it. */
async function readAtBranchTip(gitDir: string, branch: string | null, path: string): Promise<RepoFileRead | null> {
    const revision = await commitOf(gitDir, branch ? `refs/heads/${branch}` : 'HEAD');
    if (!revision) return null;
    let size: number;
    try {
        size = Number((await run('git', ['--git-dir', gitDir, 'cat-file', '-s', `${revision}:${path}`])).stdout);
    } catch {
        return { revision, text: null };
    }
    if (size > MAX_FILE_BYTES)
        throw new GitHubReadError(`${path} is larger than ${MAX_FILE_BYTES} bytes`, READ_BINDING);
    const { stdout } = await run('git', ['--git-dir', gitDir, 'cat-file', 'blob', `${revision}:${path}`]);
    return { revision, text: stdout };
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
