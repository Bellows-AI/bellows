import { gitlabHostOf } from '@factory-ai/core';
import type { Sql } from 'postgres';
import type { AppConfig } from '../config.js';
import { logger } from '../log.js';
import type { GitlabApi } from '../gitlab/gitlab-api.js';
import { createGitlabApi } from '../gitlab/gitlab-api.js';
import type { OrgRegistry } from '../orgs.js';
import type { SecretStore } from '../secrets/secret-store.js';
import { createGitlabLinks } from './gitlab-link.js';
import { createIntegrationRuntime } from './integration-recovery.js';
import { createMemberForgeGrants, type MemberForgeGrants } from './member-forge-grant.js';
import { combineRegistrations, type ProviderRegistry } from './provider-registry.js';
import { createGitHubUserHooks } from './providers/github-user.js';
import { createGitlabProvider } from './providers/gitlab.js';
import { jiraProvider } from './providers/jira.js';
import { linearProvider } from './providers/linear.js';

/** The outbound OAuth composition `main.ts` boots with, apart from it so a test builds the same thing (docs/connections.md). */

/** Every outbound OAuth provider: Jira by ATLASSIAN_CLIENT_ID/SECRET, Linear by LINEAR_CLIENT_ID/SECRET. */
const providerRegistry = ({ callbackOrigin, jira, linear }: AppConfig['integrations']): ProviderRegistry =>
    combineRegistrations([jiraProvider(jira, callbackOrigin), linearProvider(linear, callbackOrigin)]);

/**
 * The outbound OAuth runtime over every provider registration; with none configured it serves only the recovery of
 * rows and the destroy of a revoked grant's secret. In github mode it also looks up the refresh hooks of the member's
 * GitHub grant (never a provider a person can start) and builds the store a sign-in keeps that grant in.
 */
export function composeIntegrations(deps: {
    config: AppConfig;
    sql: Sql;
    crossOrg: { sql: Sql };
    secrets: SecretStore;
    ready: Promise<unknown>;
    /** The tests' seam: where GitLab hosts are reached. Absent, `https://<host>`. */
    gitlab?: { api?: GitlabApi; originOf?: (host: string) => string };
    /** The tests' seam: the member grants' clock. */
    clock?: () => number;
}) {
    const { config, sql, crossOrg, secrets, ready } = deps;
    const gitlab = composeGitlab({ sql, config, ...deps.gitlab });
    const registry = providerRegistry(config.integrations);
    const githubUser = config.auth.mode === 'github' ? createGitHubUserHooks(config.auth) : null;
    const integrations = createIntegrationRuntime({
        sql,
        crossOrgSql: crossOrg.sql,
        secrets,
        // A GitLab provider is the org's own application (`gitlab:<host>`): looked up with the org, never shared.
        providers: (provider, orgId) =>
            githubUser?.id === provider
                ? githubUser
                : ((orgId === undefined ? undefined : gitlab.provider.hooksFor(orgId, provider)) ??
                  registry.providers(provider)),
        // GitLab's client is the org's own application, read from its connection (never the static registry).
        clients: async (provider, orgId) => {
            const host = gitlabHostOf(provider);
            if (host === null) return registry.clients(provider);
            return (await gitlab.provider.clientOf(orgId, host)) ?? undefined;
        },
        callbackOrigin: config.integrations.callbackOrigin,
        log: (d) => logger('integrations').info(d, 'integration diagnostic'),
    });
    const memberGrants = githubUser
        ? createMemberForgeGrants({
              sql,
              crossOrgSql: crossOrg.sql,
              ready,
              secrets,
              lineageOf: integrations.lineageOf,
              ...(deps.clock ? { now: deps.clock } : {}),
          })
        : undefined;
    return { registry, integrations, memberGrants, gitlab };
}

/**
 * The GitLab side of the OAuth runtime: the API client and the per-org hooks. The hooks read the org's application
 * through the org registry, which is built after the runtime needs them, so `bindOrgs` hands it over once it exists.
 */
function composeGitlab({
    sql,
    config,
    api: gitlabApi = createGitlabApi(),
    originOf,
}: {
    sql: Sql;
    config: AppConfig;
    api?: GitlabApi;
    originOf?: (host: string) => string;
}) {
    const late: { orgs?: OrgRegistry } = {};
    const gitlab = createGitlabProvider({
        api: gitlabApi,
        ...(originOf ? { originOf } : {}),
        applicationOf: async (orgId, host) => {
            const runtime = await late.orgs?.for(orgId);
            if (!runtime?.forgeConnections) throw new Error('organization unavailable');
            return runtime.forgeConnections.application(host);
        },
    });
    return {
        api: gitlabApi,
        provider: gitlab,
        /** Hands the provider the org registry, and builds the link service over it; none without member grants. */
        bindOrgs: (orgs: OrgRegistry, memberGrants: MemberForgeGrants | undefined) => {
            late.orgs = orgs;
            return memberGrants
                ? createGitlabLinks({
                      sql,
                      connectionsOf: async (orgId) => (await orgs.for(orgId))?.forgeConnections,
                      provider: gitlab,
                      api: gitlabApi,
                      memberGrants,
                      callbackOrigin: config.integrations.callbackOrigin,
                  })
                : undefined;
        },
    };
}
