import type { GitHubAppClient } from '../src/github/app-client.js';

const unstubbed = (method: string) => async (): Promise<never> => {
    throw new Error(`${method} is not stubbed`);
};

/** An App client that only lists repositories — the repo-source arm, without the network. */
export const listingClient = (listRepositories: GitHubAppClient['listRepositories']): GitHubAppClient => ({
    listRepositories,
    readPullRequest: unstubbed('readPullRequest'),
    mergePullRequest: unstubbed('mergePullRequest'),
    readBranchState: unstubbed('readBranchState'),
    readBranchHead: unstubbed('readBranchHead'),
    readFileAtBranchTip: unstubbed('readFileAtBranchTip'),
});
