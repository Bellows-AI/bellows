import type { ForgeSource } from '../src/forge/forge-client.js';
import type { GitHubAppClient } from '../src/github/app-client.js';
import type { PrWriter } from '../src/github/pr-write.js';

/**
 * A GitHub forge source over stubbed installation reads (and an optional writer): only the methods a test names are
 * there, so an unexpected call fails loudly as "not a function". The stubs keep the GitHub client's own signatures.
 */
export const githubForge = (reads: Partial<GitHubAppClient>, writer?: PrWriter): ForgeSource => ({
    github: { reads: reads as GitHubAppClient, ...(writer ? { writer } : {}) },
});
