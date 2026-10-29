import { randomBytes } from 'node:crypto';
import { RUNNER_TOKEN_PERMISSIONS } from './github/app-token.js';
import { start } from './main.js';

/*
 * The lanes' entry (scripts/test-jobs.sh, scripts/test-k8s.sh --cluster): the offline board of
 * `offline.ts` plus a stand-in for the runner credential route's mint (docs/connections.md), so a
 * runner's GitHub helper has a short-lived token to renew. Code, not a flag, like `offline.ts`: no
 * environment reaches it. Each token is random and authenticates nothing; it lives
 * LANE_TOKEN_SECONDS — a few seconds past the helper's five-minute renewal skew — so a lane that
 * waits that long sees the cached token expire and a fresh one minted.
 */
const LANE_TOKEN_SECONDS = 303;
const MS_PER_SECOND = 1000;
const TOKEN_BYTES = 16;

await start({
    github: { mode: 'none' },
    githubMint: async (_orgId, repo) => ({
        token: `lane_${randomBytes(TOKEN_BYTES).toString('hex')}`,
        expiresAt: new Date(Date.now() + LANE_TOKEN_SECONDS * MS_PER_SECOND).toISOString(),
        permissions: { ...RUNNER_TOKEN_PERMISSIONS },
        repositories: repo ? [repo.split('/')[1] ?? repo] : [],
    }),
    // No GitHub behind a lane token: the revoke the runner's clear asks has nothing to call.
    githubRevoke: async () => 'revoked',
});
