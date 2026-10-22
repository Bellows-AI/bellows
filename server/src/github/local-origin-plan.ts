import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BELLOWS_FILE, createPlanReader, type PlanRead, type PlanReader } from '../workspace/bellows-plan.js';
import { READ_BINDING, READ_TRANSPORT } from '@factory-ai/core';
import { MAX_FILE_BYTES, type RepoFileRead } from './file-read.js';
import { GitHubReadError } from './pr-read.js';

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

/** One read's deadline and git binary, handed to every git call of the helper chain. */
interface GitCtx {
    readonly signal: AbortSignal;
    readonly bin: string;
}

/** Above `MAX_FILE_BYTES`, so an oversized file overflows (rejects) instead of being truncated. */
const GIT_MAX_BUFFER = MAX_FILE_BYTES * 2;

/** A finished `git`: its exit status (null when killed) and stdout. */
interface GitExit {
    readonly code: number | null;
    readonly stdout: string;
}

/**
 * Runs `git` as the leader of its own process group, so the deadline kills the transport helpers it
 * forks (`git-remote-https`, `ssh`) along with it. Rejects on abort, a spawn failure or an
 * oversized stdout.
 */
function runGroup(ctx: GitCtx, args: string[]): Promise<GitExit> {
    return new Promise((resolve, reject) => {
        if (ctx.signal.aborted) {
            reject(new Error('aborted before start'));
            return;
        }
        const child = spawn(ctx.bin, args, {
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        });
        const chunks: Buffer[] = [];
        let size = 0;
        let failure: Error | null = null;
        const killGroup = (reason: Error) => {
            failure ??= reason;
            try {
                if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
            } catch {
                // The group already exited.
            }
        };
        const onAbort = () => killGroup(new Error('deadline exceeded'));
        ctx.signal.addEventListener('abort', onAbort, { once: true });
        child.stdout.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > GIT_MAX_BUFFER) killGroup(new Error('stdout exceeded the read cap'));
            else chunks.push(chunk);
        });
        child.stderr.resume();
        child.on('error', (e) => {
            ctx.signal.removeEventListener('abort', onAbort);
            reject(failure ?? e);
        });
        child.on('close', (code) => {
            ctx.signal.removeEventListener('abort', onAbort);
            if (failure) reject(failure);
            else resolve({ code, stdout: Buffer.concat(chunks).toString('utf8') });
        });
    });
}

/**
 * `git args` under the read's deadline: stdout, or null when it exits with one of `absentCodes`
 * (a confirmed negative answer — `ls-remote --exit-code` 2, `symbolic-ref -q` 1). Anything else —
 * another exit, an abort, a timeout, a missing binary — is an outage, never an absence.
 */
async function git(ctx: GitCtx, args: string[], absentCodes: readonly number[] = []): Promise<string | null> {
    const verb = args.find((a) => !a.startsWith('-')) ?? '';
    let exit: GitExit;
    try {
        exit = await runGroup(ctx, args);
    } catch (e) {
        throw new GitHubReadError(`git ${verb}: ${(e as Error).message}`, READ_TRANSPORT);
    }
    if (exit.code === 0) return exit.stdout;
    if (exit.code !== null && absentCodes.includes(exit.code)) return null;
    throw new GitHubReadError(`git ${verb}: exited ${exit.code ?? 'by signal'}`, READ_TRANSPORT);
}

/** The commit at the tip of `ref` in the bare repository `gitDir` — an exact ref, never a revision expression. */
async function tipOf(ctx: GitCtx, gitDir: string, ref: string): Promise<string | null> {
    // Exits 0 whether or not the ref exists; a pattern can match more, so only the exact name counts.
    const refs =
        (await git(ctx, ['--git-dir', gitDir, 'for-each-ref', '--format=%(refname) %(objectname)', ref])) ?? '';
    const line = refs.split('\n').find((entry) => entry.startsWith(`${ref} `));
    return line ? line.slice(ref.length + 1) : null;
}

/** `readFileAtBranchTip` over a local bare repository, in the shape the App client answers it. */
async function readAtBranchTip(ctx: GitCtx, gitDir: string, ref: string, path: string): Promise<RepoFileRead | null> {
    const revision = await tipOf(ctx, gitDir, ref);
    if (!revision) return null;
    // `<mode> <type> <oid> <size>\t<path>`, or nothing at all for a path the commit does not have.
    const entry = (await git(ctx, ['--git-dir', gitDir, 'ls-tree', '-l', revision, '--', path]))?.trim();
    if (!entry) return { revision, text: null };
    const [, type, oid, size] = entry.split(/\s+/);
    if (type !== 'blob' || !oid) throw new GitHubReadError(`${path} is not a file`, READ_BINDING);
    if (Number(size) > MAX_FILE_BYTES)
        throw new GitHubReadError(`${path} is larger than ${MAX_FILE_BYTES} bytes`, READ_BINDING);
    return { revision, text: (await git(ctx, ['--git-dir', gitDir, 'cat-file', 'blob', oid])) ?? '' };
}

/**
 * The branch ref to read at `url`: the named branch, or the remote's HEAD target when `branch` is
 * null. Null is a CONFIRMED absence (ls-remote exit 2, or a HEAD that names no branch); every other
 * failure throws.
 */
async function resolveRef(ctx: GitCtx, url: string, branch: string | null): Promise<string | null> {
    if (branch === null) {
        const out = (await git(ctx, ['ls-remote', '--symref', url, 'HEAD'])) ?? '';
        const match = /^ref: (refs\/heads\/\S+)\tHEAD$/m.exec(out);
        return match?.[1] ?? null;
    }
    const ref = `refs/heads/${branch}`;
    const out = await git(ctx, ['ls-remote', '--exit-code', url, ref], [2]);
    // A pattern can match more than the exact name (`*`), so only the exact ref counts.
    return out?.split('\n').some((line) => line.endsWith(`\t${ref}`)) ? ref : null;
}

export const PLAN_READ_TIMEOUT_MS = 20_000;

/**
 * The offline board's plan source (the code-only `none` arm, which has no App client): a
 * repository's plan fetched from its origin at `<base>/<owner>/<name>.git` (depth 1, into a
 * throwaway bare repository) and read through the same validation and refusals the App path uses.
 * One deadline covers the whole read. A repository or branch the origin confirms absent is a plan
 * refusal VALUE; an unreachable or unknown origin, a git failure or a timeout is an outage
 * (`READ_TRANSPORT`) — the claim is retried, never decided on an unconfirmed read.
 */
export function createOriginPlanReader(
    base: string,
    {
        timeoutMs = PLAN_READ_TIMEOUT_MS,
        tmpRoot = tmpdir(),
        gitBin = 'git',
    }: { timeoutMs?: number; tmpRoot?: string; gitBin?: string } = {}
): PlanReader {
    return {
        async read(repo, baseBranch) {
            if (!REPO_LABEL.test(repo)) return unplanned(`${BELLOWS_FILE} of ${repo}: not an owner/name repository`);
            const url = `${base}/${repo}.git`;
            const ctx: GitCtx = { signal: AbortSignal.timeout(timeoutMs), bin: gitBin };
            let tmp: string | null = null;
            try {
                tmp = await mkdtemp(join(tmpRoot, 'factory-plan-')).catch((e: Error) => {
                    throw new GitHubReadError(`mkdtemp in ${tmpRoot}: ${e.message}`, READ_TRANSPORT);
                });
                const gitDir = tmp;
                await git(ctx, ['init', '-q', '--bare', gitDir]);
                const ref = await resolveRef(ctx, url, baseBranch);
                if (ref !== null) {
                    await git(ctx, [
                        '--git-dir',
                        gitDir,
                        'fetch',
                        '-q',
                        '--depth',
                        '1',
                        '--no-tags',
                        url,
                        `+${ref}:${ref}`,
                    ]);
                }
                return await createPlanReader({
                    readFileAtBranchTip: (_repo, _branch, path) =>
                        ref === null ? Promise.resolve(null) : readAtBranchTip(ctx, gitDir, ref, path),
                }).read(repo, baseBranch);
            } finally {
                if (tmp !== null) {
                    await rm(tmp, { recursive: true, force: true }).catch((e: Error) =>
                        console.error(`[plan] could not remove ${tmp}: ${e.message}`)
                    );
                }
            }
        },
    };
}
