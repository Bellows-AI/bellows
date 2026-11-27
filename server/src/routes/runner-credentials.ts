import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import type { AttemptOfLease } from '../db/attempt-of-lease.js';
import type { OrgRegistry } from '../orgs.js';
import { agentTitleRoutes } from './agent-title.js';
import { connectionCredentialRoutes } from './connection-credential.js';
import { gitlabAccessOf } from '../forge/forge-gate.js';
import { forgeCredentialRoutes } from './forge-credential.js';
import { agentChangeRequestRoutes } from './jobs/job-handlers-change-request.js';
import { githubCredentialRoutes, type GithubMint, type GithubRevoke } from './github-credential.js';
import { integrationRoutes } from './integrations.js';
import { operationReceiptRoutes } from './operation-receipts.js';
import { combineRegistrations } from '../integrations/provider-registry.js';

/** Each org's own installation mints its runners' tokens; an org without one has none to give. */
export const orgMint =
    (orgs: OrgRegistry): GithubMint =>
    async (orgId, repo) => {
        const tokens = (await orgs.for(orgId))?.githubToken;
        return tokens ? tokens.fresh(repo) : null;
    };

/** Each org's own installation revokes its runners' tokens; null when the org holds none. */
const orgRevoke =
    (orgs: OrgRegistry): GithubRevoke =>
    async (orgId, token) => {
        const tokens = (await orgs.for(orgId))?.githubToken;
        return tokens ? tokens.revoke(token) : null;
    };

type RunnerCredentialDeps = Pick<
    AppDeps,
    | 'orgs'
    | 'attemptOfLease'
    | 'pairMatches'
    | 'operationReceipts'
    | 'agentTitle'
    | 'connectionListing'
    | 'integrations'
    | 'githubMint'
    | 'githubRevoke'
    | 'memberGrants'
    | 'gitlabApi'
    | 'config'
>;

/** The routes that check the attempt pair on every call: each exists exactly when the checks it needs do. */
async function registerAttemptRoutes(
    app: FastifyInstance,
    deps: RunnerCredentialDeps,
    attemptOfLease: AttemptOfLease
): Promise<void> {
    const { orgs, pairMatches, operationReceipts, agentTitle, connectionListing, integrations, config } = deps;
    await app.register(
        githubCredentialRoutes({
            attemptOfLease,
            mint: deps.githubMint ?? orgMint(orgs),
            pairMatches,
            revoke: deps.githubRevoke ?? orgRevoke(orgs),
        })
    );
    if (integrations) {
        await app.register(connectionCredentialRoutes({ attemptOfLease, integrations, listing: connectionListing }));
    }
    if (deps.memberGrants) {
        const publicUrl = config.auth.mode === 'github' ? config.auth.publicUrl : '';
        const forgeDeps = { attemptOfLease, memberGrants: deps.memberGrants, orgs, publicUrl };
        await app.register(forgeCredentialRoutes(forgeDeps));
        await app.register(agentChangeRequestRoutes({ ...forgeDeps, gitlab: gitlabAccessOf(orgs, deps.gitlabApi) }));
    }
    if (pairMatches && operationReceipts) {
        await app.register(operationReceiptRoutes({ attemptOfLease, pairMatches, receipts: operationReceipts }));
    }
    if (agentTitle) await app.register(agentTitleRoutes({ attemptOfLease, agentTitle }));
}

/**
 * The routes a runner spends through with its attempt pair: the GitHub credential, the managed-connection broker, the
 * member's GitLab grant and the operation receipts, each existing exactly when its per-call check does.
 */
export async function registerRunnerCredentialRoutes(app: FastifyInstance, deps: RunnerCredentialDeps): Promise<void> {
    if (deps.attemptOfLease) await registerAttemptRoutes(app, deps, deps.attemptOfLease);
    const { integrations } = deps;
    // The person-facing connect: a signed-in session, not a lease, so it does not wait for `attemptOfLease`.
    if (integrations?.flowOf) {
        // Absent, no provider is registered: a start is refused as not found and a refusal names the provider alone.
        const none = combineRegistrations([]);
        await app.register(
            integrationRoutes({
                flowOf: integrations.flowOf,
                configured: integrations.configured,
                catalog: integrations.catalog,
                providers: integrations.ids ?? none.ids,
                notConfiguredOf: integrations.notConfiguredOf ?? none.notConfiguredOf,
            })
        );
    }
}
