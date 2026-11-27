// The repositories behind the fake GitLab: one bare git repository per project id under `<root>/<id>.git`, so
// the REST side (branches, files, merges) and git smart-HTTP read and write the same refs.
// A host and lane tool: it shells out to `git` (present on the host, in the runner images and in the lane's pod).
import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
/** The unit separator, spelled the way for-each-ref and log each take it. */
const FIELD = '%1f';
const LOG_FIELD = '%x1f';
const FIELD_SEPARATOR = '\x1f';
/** git reads no user or system config here, whatever the host has. */
export const GIT_ISOLATION = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };

const identityEnv = ({ name, email }, date) => ({
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
    ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
});
const stripBrackets = (email) => email.replace(/^<|>$/g, '');
/** A ref a client typed is never an option, a revision range or an object path. */
const plainRef = (ref) => typeof ref === 'string' && ref !== '' && !ref.startsWith('-') && !/[\s:^~?*[\\]|\.\./.test(ref);

export const createRepos = (root) => {
    const dirOf = (id) => join(root, `${id}.git`);
    /** Run git in a repository (or any directory); the stdout as text, or rejects with git's stderr. */
    const run = (cwd, args, { env = {}, input } = {}) =>
        new Promise((resolve, reject) => {
            const child = execFile(
                'git',
                args,
                { cwd, env: { PATH: process.env.PATH, ...GIT_ISOLATION, ...env }, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'buffer' },
                (error, stdout, stderr) => (error ? reject(new Error(`git ${args[0]}: ${stderr}`)) : resolve(stdout))
            );
            if (input !== undefined) child.stdin.end(input);
        });
    const text = async (id, args, options) => (await run(dirOf(id), args, options)).toString().trim();
    /** The answer, or null when git says no: an unknown ref, a missing path. */
    const attempt = async (id, args, options) => {
        try {
            return await text(id, args, options);
        } catch {
            return null;
        }
    };

    const resolve = async (id, ref) => (plainRef(ref) ? attempt(id, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]) : null);
    const listBranches = async (id) => {
        const out = await text(id, [
            'for-each-ref',
            `--format=%(refname:short)${FIELD}%(objectname)${FIELD}%(contents:subject)${FIELD}%(authorname)${FIELD}%(authoremail)${FIELD}%(committerdate:iso-strict)`,
            'refs/heads',
        ]);
        return out
            .split('\n')
            .filter(Boolean)
            .map((line) => {
                const [name, sha, message, authorName, authorEmail, date] = line.split(FIELD_SEPARATOR);
                return { name, sha, message, author: { name: authorName, email: stripBrackets(authorEmail) }, date };
            });
    };
    /** A commit over `tree` with the given parents, written to no ref. */
    const commitTree = async (id, tree, parents, message, author, date) =>
        text(id, ['commit-tree', tree, ...parents.flatMap((parent) => ['-p', parent]), '-m', message], {
            env: identityEnv(author, date),
        });

    return {
        root,
        dirOf,
        async create(id, { defaultBranch, files = {}, seedDir, author, date }) {
            mkdirSync(root, { recursive: true });
            await run(root, ['init', '--bare', '-q', '-b', defaultBranch, dirOf(id)]);
            const work = mkdtempSync(join(tmpdir(), 'fake-gitlab-seed-'));
            try {
                if (seedDir) cpSync(seedDir, work, { recursive: true });
                for (const [path, content] of Object.entries(files)) {
                    mkdirSync(dirname(join(work, path)), { recursive: true });
                    writeFileSync(join(work, path), content);
                }
                await run(work, ['init', '-q', '-b', defaultBranch]);
                await run(work, ['add', '-A']);
                await run(work, ['commit', '-q', '--allow-empty', '-m', 'Initial commit'], { env: identityEnv(author, date) });
                await run(work, ['push', '-q', dirOf(id), defaultBranch]);
            } finally {
                rmSync(work, { recursive: true, force: true });
            }
        },
        /** Commit `files` on top of `branch` (made from the default branch when missing). */
        async commit(id, { branch, files, message, author, date }) {
            const parent = (await resolve(id, `refs/heads/${branch}`)) ?? (await text(id, ['rev-parse', 'HEAD']));
            const scratch = mkdtempSync(join(tmpdir(), 'fake-gitlab-index-'));
            try {
                const env = { GIT_INDEX_FILE: join(scratch, 'index') };
                await text(id, ['read-tree', parent], { env });
                for (const [path, content] of Object.entries(files)) {
                    const blob = await text(id, ['hash-object', '-w', '--stdin'], { input: content });
                    await text(id, ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { env });
                }
                const tree = await text(id, ['write-tree'], { env });
                const sha = await commitTree(id, tree, [parent], message, author, date);
                await text(id, ['update-ref', `refs/heads/${branch}`, sha]);
                return sha;
            } finally {
                rmSync(scratch, { recursive: true, force: true });
            }
        },
        branches: listBranches,
        async branch(id, name) {
            return (await listBranches(id)).find((branch) => branch.name === name) ?? null;
        },
        async createBranch(id, name, ref) {
            const sha = await resolve(id, ref);
            if (!sha || !plainRef(name) || (await attempt(id, ['check-ref-format', `refs/heads/${name}`])) === null) return null;
            await text(id, ['update-ref', `refs/heads/${name}`, sha, '']);
            return this.branch(id, name);
        },
        async deleteBranch(id, name) {
            if (!plainRef(name) || !(await resolve(id, `refs/heads/${name}`))) return false;
            await text(id, ['update-ref', '-d', `refs/heads/${name}`]);
            return true;
        },
        resolve,
        async file(id, ref, path) {
            const sha = await resolve(id, ref);
            if (!sha || path.startsWith('-')) return null;
            try {
                const content = await run(dirOf(id), ['cat-file', 'blob', `${sha}:${path}`]);
                return { content, blobId: await text(id, ['rev-parse', `${sha}:${path}`]), commitId: sha };
            } catch {
                return null;
            }
        },
        /** The best common ancestor of two commits, or null when either is unknown or they share none. */
        async mergeBase(id, a, b) {
            const [one, two] = await Promise.all([resolve(id, a), resolve(id, b)]);
            return one && two ? attempt(id, ['merge-base', one, two]) : null;
        },
        /** Three-way merge of the source into the target: the merged tree's id, or null when the two conflict. */
        async mergeTree(id, source, target) {
            const into = await resolve(id, `refs/heads/${target}`);
            const from = await resolve(id, `refs/heads/${source}`);
            if (!into || !from) return null;
            const out = await attempt(id, ['merge-tree', '--write-tree', into, from]);
            return out === null ? null : out.split('\n')[0];
        },
        /** Merge the source into the target keeping both sides' changes: one commit when squashed, else a merge commit that also parents the source. Null on a conflict, no ref moved. */
        async merge(id, { source, target, squash, message, author, date }) {
            const tree = await this.mergeTree(id, source, target);
            if (!tree) return null;
            const from = await text(id, ['rev-parse', `refs/heads/${source}`]);
            const into = await text(id, ['rev-parse', `refs/heads/${target}`]);
            const sha = await commitTree(id, tree, squash ? [into] : [into, from], message, author, date);
            await text(id, ['update-ref', `refs/heads/${target}`, sha, into]);
            return sha;
        },
        /** What `target...source` changed, one entry per file as GitLab's MR diffs list them: null when either branch is gone. */
        async diff(id, source, target) {
            const to = await resolve(id, `refs/heads/${source}`);
            const from = await resolve(id, `refs/heads/${target}`);
            if (!to || !from) return null;
            const out = await text(id, ['diff', '--no-color', '--no-ext-diff', '-M', `${from}...${to}`]);
            return out
                .split(/^diff --git /m)
                .filter(Boolean)
                .map((chunk) => {
                    const [head, ...rest] = chunk.split(/^@@/m);
                    const field = (name) => new RegExp(`^${name} (.*)$`, 'm').exec(head)?.[1];
                    const [a, b] = /^a\/(.*) b\/(.*)$/m.exec(head.split('\n')[0]).slice(1);
                    return {
                        old_path: field('rename from') ?? a,
                        new_path: field('rename to') ?? b,
                        new_file: /^new file mode/m.test(head),
                        deleted_file: /^deleted file mode/m.test(head),
                        renamed_file: /^rename from/m.test(head),
                        diff: rest.length ? `@@${rest.join('@@')}` : '',
                    };
                });
        },
        /** Every ref and the commit it points at, as `{ 'refs/heads/main': sha }`. */
        async refs(id) {
            const out = await text(id, ['for-each-ref', `--format=%(refname)${FIELD}%(objectname)`]);
            return Object.fromEntries(
                out
                    .split('\n')
                    .filter(Boolean)
                    .map((line) => line.split(FIELD_SEPARATOR))
            );
        },
        /** The commits reachable from `tip` but from none of `known`, newest first, with who wrote and who committed each. */
        async newCommits(id, tip, known) {
            const out = await text(id, [
                'log',
                `--format=%H${LOG_FIELD}%an${LOG_FIELD}%ae${LOG_FIELD}%cn${LOG_FIELD}%ce`,
                tip,
                ...(known.length ? ['--not', ...known] : []),
            ]);
            return out
                .split('\n')
                .filter(Boolean)
                .map((line) => {
                    const [sha, authorName, authorEmail, committerName, committerEmail] = line.split(FIELD_SEPARATOR);
                    return {
                        sha,
                        author: { name: authorName, email: authorEmail },
                        committer: { name: committerName, email: committerEmail },
                    };
                });
        },
    };
};
