// The repositories behind the fake GitLab's branch, file and merge routes, one per project id.
// In memory for now: a commit is `{ files, parents, message, author, date }` under a made-up sha.
import { createHash } from 'node:crypto';

export const createRepos = () => {
    /** project id -> { default, branches: Map<name, sha>, commits: Map<sha, commit> } */
    const repos = new Map();
    let counter = 0;

    const addCommit = (repo, { files, parents, message, author, date }) => {
        const sha = createHash('sha1').update(`${++counter}:${message}`).digest('hex');
        repo.commits.set(sha, { sha, files, parents, message, author, date });
        return sha;
    };
    const summary = (repo, name) => {
        const sha = repo.branches.get(name);
        if (!sha) return null;
        const { message, author, date } = repo.commits.get(sha);
        return { name, sha, message, author, date };
    };
    const resolve = (repo, ref) => repo.branches.get(ref) ?? (repo.commits.has(ref) ? ref : null);

    return {
        async create(id, { defaultBranch, files, author, date }) {
            const repo = { default: defaultBranch, branches: new Map(), commits: new Map() };
            repos.set(id, repo);
            const sha = addCommit(repo, { files: new Map(Object.entries(files)), parents: [], message: 'Initial commit', author, date });
            repo.branches.set(defaultBranch, sha);
        },
        async commit(id, { branch, files, message, author, date }) {
            const repo = repos.get(id);
            const parent = repo.branches.get(branch) ?? repo.branches.get(repo.default);
            const merged = new Map(repo.commits.get(parent).files);
            for (const [path, content] of Object.entries(files)) merged.set(path, content);
            const sha = addCommit(repo, { files: merged, parents: [parent], message, author, date });
            repo.branches.set(branch, sha);
            return sha;
        },
        async branches(id) {
            const repo = repos.get(id);
            return [...repo.branches.keys()].map((name) => summary(repo, name));
        },
        async branch(id, name) {
            return summary(repos.get(id), name);
        },
        async createBranch(id, name, ref) {
            const repo = repos.get(id);
            const sha = resolve(repo, ref);
            if (!sha) return null;
            repo.branches.set(name, sha);
            return summary(repo, name);
        },
        async deleteBranch(id, name) {
            return repos.get(id).branches.delete(name);
        },
        async resolve(id, ref) {
            return resolve(repos.get(id), ref);
        },
        async file(id, ref, path) {
            const repo = repos.get(id);
            const sha = resolve(repo, ref);
            const content = sha ? repo.commits.get(sha).files.get(path) : undefined;
            if (content === undefined) return null;
            const blobId = createHash('sha1').update(content).digest('hex');
            return { content: Buffer.from(content), blobId, commitId: sha };
        },
        /** The target takes the source's tree: one commit when squashed, else a merge commit that also parents the source. */
        async merge(id, { source, target, squash, message, author, date }) {
            const repo = repos.get(id);
            const from = repo.branches.get(source);
            const into = repo.branches.get(target);
            const sha = addCommit(repo, {
                files: repo.commits.get(from).files,
                parents: squash ? [into] : [into, from],
                message,
                author,
                date,
            });
            repo.branches.set(target, sha);
            return sha;
        },
    };
};
