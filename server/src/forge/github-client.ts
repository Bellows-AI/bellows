import { formatRepoRef, MERGE_ERR_FORBIDDEN, READ_TRANSPORT, type RepoRef } from '@factory-ai/core';
import type { GitHubAppClient } from '../github/app-client.js';
import { GitHubMergeError } from '../github/pr-merge.js';
import { GitHubReadError } from '../github/pr-read.js';
import { GitHubWriteError, type PrAuth, type PrWriter } from '../github/pr-write.js';
import type { ActingCredential, ForgeClient } from './forge-client.js';

const NO_INSTALLATION = 'this board holds no GitHub installation to read through';
const NO_TOKEN = 'no acting token was given for this write';
const NO_WRITER = 'this board has no GitHub API to write through';

/**
 * The GitHub adapter: the installation reads (`createGitHubAppClient`) and the writer (`createPrWriter`) composed under
 * the neutral change-request methods, bound to one repo. Credential policy is the one the callers had: reads and the
 * merge's facts are the installation's, writes and the merge itself are sent with the acting token.
 */
export function createGitHubForgeClient(
    deps: { reads: GitHubAppClient | undefined; writer: PrWriter | undefined },
    ref: RepoRef,
    credential: ActingCredential
): ForgeClient {
    const repo = ref.path;
    const reads = (): GitHubAppClient => {
        if (!deps.reads) throw new GitHubReadError(NO_INSTALLATION, READ_TRANSPORT);
        return deps.reads;
    };
    const writer = (): PrWriter => {
        if (!deps.writer) throw new GitHubWriteError(NO_WRITER, 'uncertain');
        return deps.writer;
    };
    const auth = (signal: AbortSignal): PrAuth => {
        if (credential.kind !== 'token') throw new GitHubWriteError(NO_TOKEN, 'denied');
        return { token: credential.token, signal };
    };

    return {
        forge: ref.forge,
        async listRepositories() {
            return (await reads().listRepositories()).repos;
        },
        listBranches: (request) => reads().listBranches(repo, request),
        readBranchHead: (branch) => reads().readBranchHead(repo, branch),
        readBranchState: (branch, shas) => reads().readBranchState(repo, branch, shas),
        readFile: (branch, path) => reads().readFileAtBranchTip(repo, branch, path),
        listSkills: (branch, dirs, signal) => reads().listRepoSkills(repo, branch, dirs, signal),
        readChangeRequest: (number) => reads().readPullRequest(repo, number),
        async mergeChangeRequest(number, request) {
            if (credential.kind !== 'token') {
                throw new GitHubMergeError(`${NO_TOKEN}: ${formatRepoRef(ref)}`, MERGE_ERR_FORBIDDEN);
            }
            return reads().mergePullRequest(repo, number, request, credential.token);
        },
        async findChangeRequest(branch, signal) {
            return writer().findPullRequest(repo, branch, auth(signal));
        },
        async openChangeRequest(ask, signal) {
            return writer().openPullRequest(repo, ask, auth(signal));
        },
        async retargetChangeRequest(number, base, signal) {
            return writer().retarget(repo, number, base, auth(signal));
        },
        async editChangeRequest(number, edit, signal) {
            return writer().edit(repo, number, edit, auth(signal));
        },
    };
}
