import { REPO_ID_PARAM_LIMIT } from './routes/helpers.js';
import type { IntegrationProvider } from '@factory-ai/core';
import Fastify from 'fastify';
import type { FastifyBaseLogger, FastifyInstance, FastifyServerOptions } from 'fastify';
import type { DriverCredentialStore } from './auth/driver-credentials.js';
import type { GitHubIdentityClient } from './auth/github.js';
import { registerAuth } from './auth/plugin.js';
import { registerRequestRateLimit, trustProxyOf } from './auth/request-limits.js';
import type { OAuthStore } from './auth/oauth-store.js';
import type { MembershipReader } from './auth/membership.js';
import type { AuthStore } from './auth/store.js';
import type { AppConfig } from './config.js';
import { mcpRoutes } from './mcp/routes.js';
import { createCimdFetcher } from './oauth/cimd-fetch.js';
import { createClientResolver } from './oauth/client-resolver.js';
import { oauthRoutes } from './routes/oauth.js';
import type { InstallationRepo } from './github/app-client.js';
import { UNMATCHED_ROUTE } from './log.js';
import { registerRouteSpanHook } from './otel-scrub.js';
import type { ServerMetrics } from './metrics.js';
import type { OrgRegistry } from './orgs.js';
import type { AgentTitle } from './db/agent-title.js';
import { agentTitleRoutes } from './routes/agent-title.js';
import { errorHandler } from './routes/error-handler.js';
import type { AttemptOfLease, PairMatches } from './db/attempt-of-lease.js';
import type { IntegrationRuntime } from './integrations/integration-recovery.js';
import type { GitlabLinks } from './integrations/gitlab-link.js';
import type { MemberForgeGrants } from './integrations/member-forge-grant.js';
import { combineRegistrations } from './integrations/provider-registry.js';
import { batchRoutes } from './routes/batches/batches.js';
import type { UploadCapabilityStore } from './attachments/upload-capability-store.js';
import { attachmentRoutes } from './routes/attachments.js';
import { connectionRoutes, type DestroyRevokedSecret } from './routes/connections.js';
import { type ConnectionListing, connectionCredentialRoutes } from './routes/connection-credential.js';
import type { OperationReceipts } from './db/operation-receipts.js';
import { operationReceiptRoutes } from './routes/operation-receipts.js';
import { integrationCatalogRoutes } from './routes/integration-catalog.js';
import { integrationRoutes } from './routes/integrations.js';
import { modelSetupRoutes } from './routes/model-setup.js';
import { modelSetupVerifyRoutes } from './routes/model-setup-verify.js';
import type { ProviderKeys } from './provider-keys/verify.js';
import { githubCredentialRoutes, type GithubMint, type GithubRevoke } from './routes/github-credential.js';
import { workspaceRoutes } from './routes/workspace.js';
import { orgExecutorRoutes } from './routes/org-executors.js';
import { createConnectorRegistry, type ConnectorRegistry } from './notifications/connector.js';
import { gitlabConnectionRoutes } from './routes/gitlab-connections.js';
import { gitlabLinkRoutes } from './routes/gitlab-links.js';
import { notificationSubscriptionRoutes } from './routes/notification-subscriptions.js';
import { orgMemberRoutes } from './routes/org-members.js';
import { auditRoutes } from './routes/audit.js';
import { operatorRoutes } from './routes/operator.js';
import { operatorDriverCredentialRoutes } from './routes/operator-driver-credentials.js';
import { orgExportRoutes } from './routes/org-export.js';
import { authRoutes } from './routes/auth.js';
import { createForgeGate, type ForgeGate } from './forge/forge-gate.js';
import { createPrTokenSource } from './forge/pr-token.js';
import { createPrWriter, type PrWriter } from './github/pr-write.js';
import { forgeGrantRoutes } from './routes/forge-grants.js';
import { envRoutes } from './routes/env.js';
import { healthRoutes } from './routes/health.js';
import { ingestRoutes } from './routes/ingest.js';
import { registerTitleRoute } from './routes/jobs/job-handlers-title.js';
import { preflightRoutes } from './routes/jobs/job-preflight.js';
import { type JobRouteDeps, jobRoutes } from './routes/jobs/jobs.js';
import { repoRoutes } from './routes/repos.js';
import { skillRoutes } from './routes/skills.js';
import { skillStoreRoutes } from './routes/skills-store.js';
import { statsRoutes } from './routes/stats.js';
import { taskRoutes } from './routes/tasks.js';
import { tokenRoutes } from './routes/tokens.js';
import { versionRoutes } from './routes/version.js';
import { webhookRoutes } from './routes/webhook.js';
import { commerceRoutes } from './routes/commerce.js';
import type { CommercePlanWriter } from './db/commerce-plan-writer.js';
import { workflowRoutes } from './routes/workflows.js';
import type { SecretStore } from './secrets/secret-store.js';
import type { TelemetryStore } from './telemetry/store.js';
import { skillCatalog } from './skills.js';
import { readVersion } from './version.js';

const HTTP_NOT_FOUND = 404;
const MS_PER_SECOND = 1000;

/** Fastify takes a logger instance or logger options, never both. */
const loggingOf = (
    instance: FastifyBaseLogger | undefined,
    options: NonNullable<FastifyServerOptions['logger']>
): Pick<FastifyServerOptions, 'logger' | 'loggerInstance'> =>
    instance ? { loggerInstance: instance } : { logger: options };

declare module 'fastify' {
    interface FastifyRequest {
        /** Aborted when the app begins to close: a long-poll answers its timeout-shaped result at once. */
        readonly closing: AbortSignal;
    }
}

export interface AppDeps {
    config: AppConfig;
    /**
     * The per-org runtimes: the routes resolve the CALLER's org through it and take the repo
     * source, telemetry and stats service from there. In tests, `orgs.for` answers for any
     * org with the same runtime, which keeps the single-org route tests honest about one thing:
     * every route reads the org the caller carries, never a process constant.
     */
    orgs: OrgRegistry;
    /** Absent unless there is somewhere to write, so the ingest routes simply do not exist. */
    store?: TelemetryStore | undefined;
    /**
     * Absent means no auth at all — no hook, no /api/auth routes, every route open.
     *
     * This is the ROUTE TESTS' mode, not a deployment's: main.ts always supplies one, because the
     * database is mandatory and there is therefore always somewhere for accounts to live. It exists
     * so the seven route-test files that predate accounts keep driving the app with no cookie,
     * and it is the same bargain `store` already makes.
     *
     * A deployment that wants everything open sets AUTH_MODE=none, which is a different thing: the
     * hook still runs and still resolves a caller, so there is one code path rather than two.
     */
    auth?: AuthStore | undefined;
    /**
     * GitHub's member list of an organization, for the members page's invitations (routes/org-members.ts). Present
     * under a GitHub App; absent, the invitation read serves the sign-in link and says the list is unavailable.
     */
    githubRoster?: Pick<MembershipReader, 'roster'> | undefined;
    /**
     * The branch route's lease-pair verifier, threaded through to the auth hook. main.ts builds it
     * from the job store's SQL; the tests that exercise the runner credential stub it.
     */
    orgOfLease?: ((jobId: string, leaseToken: string) => Promise<string | null>) | undefined;
    /** The OTLP routes' runner-credential verifier (job id + ingest token), threaded through to the auth hook. */
    orgOfIngest?: ((jobId: string, ingestToken: string) => Promise<string | null>) | undefined;
    /**
     * The worker routes' org resolvers, threaded through to the auth hook beside `orgOfLease`:
     * where a pool driver credential authenticates a call, the org comes from the row its URL
     * names. main.ts builds both from the job store's SQL.
     */
    orgOfJob?: ((jobId: string) => Promise<string | null>) | undefined;
    orgOfReclaim?: ((reclaimId: string) => Promise<string | null>) | undefined;
    /** Per-driver credentials: the worker routes resolve `drv_` tokens through it; the operator issues them. */
    driverCredentials?: DriverCredentialStore | undefined;
    /**
     * The runner credential routes' per-call check (`createAttemptOfLease`); the GitHub route exists
     * exactly when it does, and the managed-connection broker when `integrations` is present too.
     * `githubMint` replaces the org's installation mint — the lanes'
     * stand-in (`offline-mint.ts`) and the tests' seam; absent, each org's App installation mints.
     */
    attemptOfLease?: AttemptOfLease | undefined;
    /** The revoke route's pair-only match (`createPairMatches`, no liveness); the route exists when it does. */
    pairMatches?: PairMatches | undefined;
    /** The runner's durable operation receipts (099); with `attemptOfLease` and `pairMatches` the receipt routes exist. */
    operationReceipts?: OperationReceipts | undefined;
    /** The running agent's own title write; with `attemptOfLease` the route exists. */
    agentTitle?: AgentTitle | undefined;
    /** The runner helper's connection list (`GET .../credentials/connections`); with `integrations` the route exists. */
    connectionListing?: ConnectionListing | undefined;
    /** The outbound OAuth runtime whose per-org resolver the broker spends through. */
    integrations?:
        | (Pick<IntegrationRuntime, 'resolverOf'> &
              Partial<Pick<IntegrationRuntime, 'destroyRevokedSecret' | 'flowOf'>> & {
                  /** The provider ids with an OAuth client registered here; `GET /api/integrations` reports it as booleans. */
                  configured?: readonly string[] | undefined;
                  /** The catalog `GET /api/integrations` answers for; the tests' seam for a provider not shipped. */
                  catalog?: readonly IntegrationProvider[] | undefined;
                  /** Every registered provider id, configured or not: a start of one unconfigured is refused, not 404. */
                  ids?: readonly string[] | undefined;
                  /** The refusal sentence of an unconfigured provider's start. */
                  notConfiguredOf?: ((provider: string) => string) | undefined;
              })
        | undefined;
    githubMint?: GithubMint | undefined;
    /** Replaces the org's installation revoke, like `githubMint` (the lanes' stand-in, the tests' seam). */
    githubRevoke?: GithubRevoke | undefined;
    /** The commerce service's plan push (095); the routes exist exactly when COMMERCE_ENABLED and this is present. */
    commercePlanWriter?: CommercePlanWriter | undefined;
    /** The delivery channels a subscription may name; absent means none, so every create is UNKNOWN_CONNECTOR. */
    notificationConnectors?: ConnectorRegistry | undefined;
    /** The inbound OAuth store: resolves an MCP access token and backs the authorization server; github mode with MCP on needs it. */
    oauth?: OAuthStore | undefined;
    /** The OAuth exchange. Absent under AUTH_MODE=none, where there is nothing to exchange with. */
    identity?: GitHubIdentityClient | undefined;
    /** The member forge grants: a sign-in keeps the GitHub grant here, and the revoke webhook breaks it. Absent, none. */
    memberGrants?: MemberForgeGrants | undefined;
    /** A person's GitLab authorization (the member's link, the admin's activation); the routes exist with it and `memberGrants`. */
    gitlabLinks?: GitlabLinks | undefined;
    /** The GitHub REST writer behind the PR route; absent, it is built from the configured API URL, and with none the route answers GITHUB_UNAVAILABLE. */
    prWriter?: PrWriter | undefined;
    /** The App slug provider — the install-page redirect. Absent offline, where it cannot ask. */
    appSlug?: (() => Promise<string>) | undefined;
    /**
     * Repos one installation can see, for the onboarding screen. Absent means the screen
     * reports repo tracking as unavailable — the offline shape, where there is no App client.
     */
    installationListing?: ((installationId: string) => Promise<InstallationRepo[] | null>) | undefined;
    /** The migration run main.ts started — what `/api/ready` reports. Absent in the route tests. */
    ready?: Promise<unknown> | undefined;
    /** What `/api/version` serves. Defaults to `readVersion()`, so a missing or invalid file fails boot. */
    version?: string;
    /** Preset ranges are a lookback from now, so the routes need the same injection point. */
    now?: () => number;
    /**
     * The board's OTEL instruments. With it the request histogram is recorded; without it (the route
     * tests) nothing is. main.ts builds it once.
     */
    metrics?: ServerMetrics | undefined;
    /** The board's root logger (`log.ts`), which main.ts supplies. */
    loggerInstance?: FastifyBaseLogger;
    /** Tests' logging options: a destination object is the capture of every line. Ignored beside `loggerInstance`. */
    logger?: FastifyServerOptions['logger'];
    /** The secret-storage seam (docs/secrets.md). main.ts supplies the PostgreSQL backend; consumers read it. */
    secrets?: SecretStore | undefined;
    /** Destroys the secret of a grant a disconnect revoked; absent, the `integrations` runtime's. */
    destroyRevokedSecret?: DestroyRevokedSecret | undefined;
    /** Uploads one process buffers at once; absent takes the route's default. */
    attachmentMaxInFlight?: number | undefined;
    /** The single-use upload capabilities; with it the upload-request routes and the capability PUT exist. */
    uploadCapabilities?: UploadCapabilityStore | undefined;
    /** The provider key check; with it `POST /api/model-setup/verify` exists. main.ts builds it for the deployment mode. */
    providerKeys?: ProviderKeys | undefined;
}

// Set as a response header rather than a <meta> tag so dev can allow the Vite HMR
// websocket without a different index.html.
export function csp(dev: boolean): string {
    const connect = dev ? "'self' ws:" : "'self'";
    return [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        `connect-src ${connect}`,
        // avatars.githubusercontent.com is where GitHub serves the profile pictures the user menu
        // and settings page render. One pinned host, never a wildcard. blob: is the composer chip's
        // thumbnail of a chosen file (an object URL); images only, never scripts.
        "img-src 'self' data: blob: https://avatars.githubusercontent.com",
        "font-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
        // Nothing embeds the SPA; the consent screen must never be framed.
        "frame-ancestors 'none'",
    ].join('; ');
}

/**
 * The MCP endpoint exists exactly when MCP_ENABLED, and only behind the auth hook: github mode resolves its bearer
 * through the OAuth store, so enabling it without one is a wiring fault, not a quiet 404.
 */
async function registerMcp(
    app: FastifyInstance,
    {
        config,
        auth,
        oauth,
        version,
        metrics,
    }: Pick<AppDeps, 'config' | 'oauth' | 'metrics'> & { auth: AuthStore; version: string }
): Promise<void> {
    if (!config.mcp.enabled) return;
    if (config.auth.mode === 'github' && !oauth) throw new Error('MCP_ENABLED needs the OAuth store');
    // Discovery, authorize, consent, token and revoke exist only where there are accounts to authorize.
    if (config.auth.mode === 'github' && oauth) {
        // A board on http loopback is a dev board: its clients may be too (the config refuses http anywhere else).
        const fetcher = createCimdFetcher({ allowLoopback: new URL(config.mcp.resource).protocol === 'http:' });
        const resolveClient = createClientResolver({ oauth, fetcher, log: app.log });
        await app.register(oauthRoutes({ config, auth, oauth, resolveClient }));
    }
    await app.register(mcpRoutes, {
        version,
        batches: config.batches.enabled,
        origin: new URL(config.mcp.resource).origin,
        metrics,
        streamsPerOrg: config.requestLimits.streamsPerOrg,
    });
}

/**
 * The routes behind the auth store beside sign-in: the personal tokens (github mode only), the installation webhook and MCP.
 */
async function registerAccountRoutes(
    app: FastifyInstance,
    {
        config,
        auth,
        orgs,
        memberGrants,
        gitlabLinks,
        oauth,
        version,
        metrics,
    }: Pick<AppDeps, 'config' | 'orgs' | 'memberGrants' | 'gitlabLinks' | 'oauth' | 'metrics'> & {
        auth: AuthStore;
        version: string;
    }
): Promise<void> {
    // The mint/list/revoke routes are github-mode only. Under `none` the hook ignores every
    // credential, so a token minted here would be inert at best — and a live personal
    // credential the day the same database flips to `github`. The settings page hides both
    // sections for exactly this reason; the API matches it.
    if (config.auth.mode !== 'none') {
        await app.register(tokenRoutes({ store: auth }));
    }
    // The installation webhook exists exactly when its secret does — its credential IS the
    // HMAC signature, so without one there is nothing to verify and no route may answer.
    if (config.webhookSecret) {
        await app.register(webhookRoutes({ store: auth, orgs, secret: config.webhookSecret, memberGrants }));
    }
    await app.register(forgeGrantRoutes({ memberGrants }));
    if (memberGrants && gitlabLinks) await app.register(gitlabLinkRoutes({ orgs, links: gitlabLinks, memberGrants }));
    await registerMcp(app, { config, auth, oauth, version, metrics });
}

/** The response headers every answer carries: the CSP and the anti-framing, anti-sniffing, no-referrer set. */
function registerSecurityHeaders(app: FastifyInstance, config: AppConfig): void {
    const header = csp(config.webRoot === null);
    app.addHook('onSend', async (_request, reply) => {
        reply.header('Content-Security-Policy', header);
        reply.header('X-Frame-Options', 'DENY');
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header('Referrer-Policy', 'no-referrer');
    });
}

/** Each org's own installation mints its runners' tokens; an org without one has none to give. */
const orgMint =
    (orgs: OrgRegistry): GithubMint =>
    async (orgId, repo) => {
        const tokens = (await orgs.for(orgId))?.githubToken;
        return tokens ? tokens.fresh(repo) : null;
    };

/**
 * The job routes' deps. The board's PR write is the token source (the starter's grant, or the org's installation
 * without member grants) and the REST writer over the API the board is configured for: the App's, or the sign-in's
 * under the offline `github` auth.
 */
const jobRouteDepsOf = (
    deps: Pick<AppDeps, 'config' | 'orgs' | 'memberGrants' | 'prWriter' | 'githubMint' | 'metrics'> & {
        forgeGate: ForgeGate | undefined;
    }
): JobRouteDeps => {
    const { config, orgs, forgeGate, memberGrants, prWriter, githubMint, metrics } = deps;
    const apiUrl =
        config.github.mode === 'app' ? config.github.apiUrl : config.auth.mode === 'github' ? config.auth.apiUrl : null;
    return {
        orgs,
        forgeGate,
        pullRequests: {
            tokens: createPrTokenSource({ memberGrants, mint: githubMint ?? orgMint(orgs) }),
            forge: { github: { writer: prWriter ?? (apiUrl === null ? undefined : createPrWriter({ apiUrl })) } },
        },
        ...(metrics ? { claimPoll: metrics.claimPoll } : {}),
    };
};

/** Each org's own installation revokes its runners' tokens; null when the org holds none. */
const orgRevoke =
    (orgs: OrgRegistry): GithubRevoke =>
    async (orgId, token) => {
        const tokens = (await orgs.for(orgId))?.githubToken;
        return tokens ? tokens.revoke(token) : null;
    };

/**
 * The routes a runner spends through with its attempt pair: the GitHub credential, the managed-connection broker and
 * the operation receipts, each existing exactly when its per-call check does.
 */
async function registerRunnerCredentialRoutes(
    app: FastifyInstance,
    deps: Pick<
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
    >
): Promise<void> {
    const {
        orgs,
        attemptOfLease,
        pairMatches,
        operationReceipts,
        agentTitle,
        connectionListing,
        integrations,
        githubMint,
        githubRevoke,
    } = deps;
    if (attemptOfLease) {
        await app.register(
            githubCredentialRoutes({
                attemptOfLease,
                mint: githubMint ?? orgMint(orgs),
                pairMatches,
                revoke: githubRevoke ?? orgRevoke(orgs),
            })
        );
        if (integrations) {
            await app.register(
                connectionCredentialRoutes({ attemptOfLease, integrations, listing: connectionListing })
            );
        }
        if (pairMatches && operationReceipts) {
            await app.register(operationReceiptRoutes({ attemptOfLease, pairMatches, receipts: operationReceipts }));
        }
        if (agentTitle) await app.register(agentTitleRoutes({ attemptOfLease, agentTitle }));
    }
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

/**
 * The routes that exist only with their dependency — commerce (and COMMERCE_ENABLED), the provider key check — and
 * the model setup the key check serves and the org's GitLab connection (pending until activated), which every board has.
 */
async function registerOptionalRoutes(
    app: FastifyInstance,
    config: AppConfig,
    orgs: OrgRegistry,
    { commercePlanWriter: writer, providerKeys, now }: Pick<AppDeps, 'commercePlanWriter' | 'providerKeys' | 'now'>
): Promise<void> {
    if (config.commerce.enabled && writer) await app.register(commerceRoutes({ orgs, writer }));
    if (providerKeys) await app.register(modelSetupVerifyRoutes({ providerKeys, now }));
    await app.register(modelSetupRoutes({ config, orgs }));
    await app.register(gitlabConnectionRoutes({ orgs }));
}

/** What the personal and the organization executor routes share: the deployment mode and the runner classes. */
const executorRouteDeps = (config: AppConfig, orgs: OrgRegistry) => ({
    orgs,
    deploymentMode: config.deploymentMode,
    runnerClasses: config.runnerClasses,
});

/** No `listen` here — that split is what lets the route tests drive the app in-process. */
export async function buildApp({
    config,
    orgs,
    store,
    auth,
    githubRoster,
    orgOfLease,
    orgOfIngest,
    orgOfJob,
    orgOfReclaim,
    driverCredentials,
    attemptOfLease,
    integrations,
    githubMint,
    githubRevoke,
    pairMatches,
    operationReceipts,
    agentTitle,
    connectionListing,
    destroyRevokedSecret,
    attachmentMaxInFlight,
    uploadCapabilities,
    identity,
    gitlabLinks,
    memberGrants,
    prWriter,
    appSlug,
    installationListing,
    commercePlanWriter,
    oauth,
    providerKeys,
    notificationConnectors = createConnectorRegistry([]),
    ready,
    version = readVersion(),
    now = Date.now,
    metrics,
    loggerInstance,
    logger = false,
}: AppDeps): Promise<FastifyInstance> {
    const app = Fastify({
        ...loggingOf(loggerInstance, logger),
        trustProxy: trustProxyOf(config.trustedProxies),
        routerOptions: { maxParamLength: REPO_ID_PARAM_LIMIT },
    });
    app.setErrorHandler(errorHandler);
    const publicUrl = config.auth.mode === 'github' ? config.auth.publicUrl : '';
    const forgeGate = createForgeGate({ memberGrants, publicUrl });

    // Aborted the moment `app.close()` begins, before it waits for the open requests: the long-polls (settle, batch
    // settle, the MCP waits) read it as `request.closing` and answer at once instead of holding the close up to
    // their timeout (docs/architecture.md).
    const closing = new AbortController();
    app.decorateRequest('closing', { getter: () => closing.signal });
    app.addHook('preClose', async () => closing.abort());

    registerSecurityHeaders(app, config);

    registerRouteSpanHook(app);

    // On the root instance, before any route: a hook inside an encapsulated plugin would miss every
    // route registered beside it. The pattern is the label, so a raw id never becomes a series.
    if (metrics) {
        app.addHook('onResponse', async (request, reply) => {
            const route = request.is404 ? UNMATCHED_ROUTE : request.routeOptions.url;
            metrics.request(
                request.method,
                route ?? UNMATCHED_ROUTE,
                reply.statusCode,
                reply.elapsedTime / MS_PER_SECOND
            );
        });
    }

    // Before every route, so nothing can be registered ahead of the wall by accident. Without a
    // store the property is still decorated, so `request.auth` reads the same everywhere rather than
    // being absent in one configuration and null in another.
    if (auth) {
        await registerAuth(app, {
            config,
            store: auth,
            orgOfLease,
            orgOfIngest,
            orgOfJob,
            orgOfReclaim,
            driverCredentials,
            oauth,
        });
        // After the auth hook, whose principal it counts.
        registerRequestRateLimit(app, { config, now });
    } else app.decorateRequest('auth', null);

    await app.register(healthRoutes(ready));
    await app.register(versionRoutes(version));
    if (auth) {
        await app.register(
            authRoutes({ config, store: auth, orgs, identity, memberGrants, appSlug, installationListing, oauth })
        );
        await registerAccountRoutes(app, { config, auth, orgs, memberGrants, gitlabLinks, oauth, version, metrics });
    }
    await app.register(skillRoutes(skillCatalog, orgs, { version }));
    await app.register(skillStoreRoutes({ orgs, builtin: skillCatalog }));
    await app.register(statsRoutes(config, orgs, auth, now));
    await app.register(repoRoutes({ config, orgs }));
    if (store) await app.register(ingestRoutes(store, orgs));
    // The board and the workflow definitions it resolves against: per-org runtimes, the routes
    // answering 503 for an org the registry has no store for — the same bargain as the env routes.
    await app.register(
        jobRoutes(jobRouteDepsOf({ config, orgs, forgeGate, memberGrants, prWriter, githubMint, metrics }))
    );
    registerTitleRoute(app, orgs);
    await app.register(preflightRoutes({ orgs, forgeGate }));
    await app.register(
        attachmentRoutes({
            orgs,
            maxInFlight: attachmentMaxInFlight,
            uploads: uploadCapabilities,
            requireBinding: config.auth.mode !== 'none',
            origin: config.mcp.enabled ? new URL(config.mcp.resource).origin : null,
        })
    );
    await app.register(taskRoutes({ orgs }));
    await app.register(workflowRoutes({ orgs }));
    // Batch plans (059): like the routes above, 503 for an org whose runtime carries no batch store.
    await app.register(batchRoutes({ orgs, enabled: config.batches.enabled, forgeGate }));
    await app.register(envRoutes({ config, orgs }));
    // The provider catalog exists on every board; where no OAuth client is wired every OAuth provider reads `unavailable`.
    await app.register(integrationCatalogRoutes({ orgs, configured: integrations?.configured }));
    // Managed connector connections (list, disconnect) and the runner-facing routes that spend them.
    await app.register(
        connectionRoutes({
            orgs,
            destroyRevokedSecret: destroyRevokedSecret ?? integrations?.destroyRevokedSecret,
        })
    );
    await registerRunnerCredentialRoutes(app, {
        orgs,
        attemptOfLease,
        pairMatches,
        operationReceipts,
        agentTitle,
        connectionListing,
        integrations,
        githubMint,
        githubRevoke,
    });
    await app.register(workspaceRoutes(executorRouteDeps(config, orgs)));
    // Plans and usage (like the webhook, only when the deployment turned commerce on) and the provider key check.
    await registerOptionalRoutes(app, config, orgs, { commercePlanWriter, providerKeys, now });
    // Organization-scoped executor profiles (issue 391): the admins' CRUD beside the personal
    // routes, the same org-resolution the workflow routes make.
    await app.register(orgExecutorRoutes(executorRouteDeps(config, orgs)));
    // The organization's export archive: an admin read over every org table and object.
    await app.register(orgExportRoutes({ orgs }));
    // Notification subscriptions: the org's settings for who hears about a task verdict.
    await app.register(
        notificationSubscriptionRoutes({
            orgs,
            connectors: notificationConnectors,
            publicUrl: config.integrations.callbackOrigin,
        })
    );
    // The member roster and its role writes (issue 410), the same person-shaped surface: the
    // caller's role decides, the store has no role of its own to check.
    // The organization's audit log export is an admin read beside the roster; the operator's org status surface
    // is the same store's (OPERATOR_GITHUB_IDS decides in the auth hook).
    if (auth) {
        await app.register(orgMemberRoutes({ store: auth, roster: githubRoster, auth: config.auth }));
        await app.register(auditRoutes({ store: auth }));
        await app.register(operatorRoutes({ store: auth }));
        await app.register(operatorDriverCredentialRoutes({ credentials: driverCredentials }));
    }

    if (config.webRoot) {
        const { default: fastifyStatic } = await import('@fastify/static');
        await app.register(fastifyStatic, { root: config.webRoot });
        app.setNotFoundHandler(async (request, reply) => {
            if (request.url.startsWith('/api/') || request.url.startsWith('/.well-known/'))
                return reply.code(HTTP_NOT_FOUND).send({ error: 'Not found' });
            return reply.sendFile('index.html');
        });
    }

    return app;
}
