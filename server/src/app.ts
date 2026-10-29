import Fastify from 'fastify';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import type { GitHubIdentityClient } from './auth/github.js';
import { registerAuth } from './auth/plugin.js';
import type { AuthStore } from './auth/store.js';
import type { AppConfig } from './config.js';
import type { InstallationRepo } from './github/app-client.js';
import type { ServerMetrics } from './metrics.js';
import type { OrgRegistry } from './orgs.js';
import type { ConnectionOfLease } from './db/connection-store.js';
import type { AttemptOfLease, PairMatches } from './db/attempt-of-lease.js';
import type { IntegrationRuntime } from './integrations/integration-recovery.js';
import { batchRoutes } from './routes/batches/batches.js';
import { connectionRoutes, type CloudIdLookup, type DestroyRevokedSecret } from './routes/connections.js';
import { connectorJiraRoutes } from './routes/connector-jira.js';
import { connectionCredentialRoutes } from './routes/connection-credential.js';
import { integrationRoutes } from './routes/integrations.js';
import { githubCredentialRoutes, type GithubMint, type GithubRevoke } from './routes/github-credential.js';
import { workspaceRoutes } from './routes/workspace.js';
import { orgExecutorRoutes } from './routes/org-executors.js';
import { orgMemberRoutes } from './routes/org-members.js';
import { authRoutes } from './routes/auth.js';
import { envRoutes } from './routes/env.js';
import { healthRoutes } from './routes/health.js';
import { ingestRoutes } from './routes/ingest.js';
import { jobRoutes } from './routes/jobs/jobs.js';
import { prometheusRoutes } from './routes/prometheus.js';
import { repoRoutes } from './routes/repos.js';
import { skillRoutes } from './routes/skills.js';
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
const UNMATCHED_ROUTE = '<unmatched>';

export interface AppDeps {
    config: AppConfig;
    /**
     * The per-org runtimes: the routes resolve the CALLER's org through it and take the repo
     * source, telemetry and stats service from there (#99). In tests, `orgs.for` answers for any
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
     * The branch route's lease-pair verifier, threaded through to the auth hook. main.ts builds it
     * from the job store's SQL; the tests that exercise the runner credential stub it.
     */
    orgOfLease?: ((jobId: string, leaseToken: string) => Promise<string | null>) | undefined;
    /**
     * The worker routes' org resolvers, threaded through to the auth hook beside `orgOfLease`:
     * where the shared board secret authenticates a call, the org comes from the row its URL
     * names. main.ts builds both from the job store's SQL.
     */
    orgOfJob?: ((jobId: string) => Promise<string | null>) | undefined;
    orgOfReclaim?: ((reclaimId: string) => Promise<string | null>) | undefined;
    /**
     * The connector proxy's per-call check (`createConnectionOfLease`); the proxy route exists
     * exactly when it does. `fetchFn` and `cloudIdLookup` are the test seams for Atlassian.
     */
    connectionOfLease?: ConnectionOfLease | undefined;
    /**
     * The runner credential routes' per-call check (`createAttemptOfLease`); the GitHub route exists
     * exactly when it does, and the managed-connection broker when `integrations` is present too.
     * `githubMint` replaces the org's installation mint — the lanes'
     * stand-in (`offline-mint.ts`) and the tests' seam; absent, each org's App installation mints.
     */
    attemptOfLease?: AttemptOfLease | undefined;
    /** The revoke route's pair-only match (`createPairMatches`, no liveness); the route exists when it does. */
    pairMatches?: PairMatches | undefined;
    /** The outbound OAuth runtime whose per-org resolver the broker spends through. */
    integrations?:
        | (Pick<IntegrationRuntime, 'resolverOf'> &
              Partial<Pick<IntegrationRuntime, 'destroyRevokedSecret' | 'flowOf'>>)
        | undefined;
    githubMint?: GithubMint | undefined;
    /** Replaces the org's installation revoke, like `githubMint` (the lanes' stand-in, the tests' seam). */
    githubRevoke?: GithubRevoke | undefined;
    fetchFn?: typeof fetch | undefined;
    /** The commerce service's plan push (095); the routes exist exactly when COMMERCE_ENABLED and this is present. */
    commercePlanWriter?: CommercePlanWriter | undefined;
    cloudIdLookup?: CloudIdLookup | undefined;
    /** The OAuth exchange. Absent under AUTH_MODE=none, where there is nothing to exchange with. */
    identity?: GitHubIdentityClient | undefined;
    /** The App slug provider — the install-page redirect. Absent offline, where it cannot ask. */
    appSlug?: (() => Promise<string>) | undefined;
    /**
     * Repos one installation can see, for the onboarding screen (#125). Absent means the screen
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
     * The board's Prometheus series. With it: the request histogram and `GET /api/metrics` exist;
     * without it (the route tests) neither does. main.ts builds it once.
     */
    metrics?: ServerMetrics | undefined;
    /** `true` for the server's own log; a destination object is the tests' capture of every line. */
    logger?: FastifyServerOptions['logger'];
    /** The secret-storage seam (docs/secrets.md). main.ts supplies the PostgreSQL backend; consumers read it. */
    secrets?: SecretStore | undefined;
    /** Destroys the secret of a grant a disconnect revoked (BEL-138); absent, the `integrations` runtime's. */
    destroyRevokedSecret?: DestroyRevokedSecret | undefined;
}

// Set as a response header rather than a <meta> tag so dev can allow the Vite HMR
// websocket without a different index.html.
function csp(dev: boolean): string {
    const connect = dev ? "'self' ws:" : "'self'";
    return [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        `connect-src ${connect}`,
        // avatars.githubusercontent.com is where GitHub serves the profile pictures the user menu
        // and settings page render. One pinned host, never a wildcard.
        "img-src 'self' data: https://avatars.githubusercontent.com",
        "font-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
    ].join('; ');
}

/** Each org's own installation mints its runners' tokens; an org without one has none to give. */
const orgMint =
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

/**
 * The routes a runner spends through with its attempt pair: the Jira proxy and the GitHub
 * credential, each existing exactly when its per-call check does.
 */
async function registerRunnerCredentialRoutes(
    app: FastifyInstance,
    deps: Pick<
        AppDeps,
        | 'orgs'
        | 'connectionOfLease'
        | 'attemptOfLease'
        | 'pairMatches'
        | 'integrations'
        | 'githubMint'
        | 'githubRevoke'
        | 'fetchFn'
    >
): Promise<void> {
    const { orgs, connectionOfLease, attemptOfLease, pairMatches, integrations, githubMint, githubRevoke, fetchFn } =
        deps;
    if (connectionOfLease) {
        await app.register(connectorJiraRoutes({ connectionOfLease, ...(fetchFn ? { fetchFn } : {}) }));
    }
    if (attemptOfLease) {
        await app.register(
            githubCredentialRoutes({
                attemptOfLease,
                mint: githubMint ?? orgMint(orgs),
                pairMatches,
                revoke: githubRevoke ?? orgRevoke(orgs),
            })
        );
        if (integrations) await app.register(connectionCredentialRoutes({ attemptOfLease, integrations }));
    }
    // The person-facing connect: a signed-in session, not a lease, so it does not wait for `attemptOfLease`.
    if (integrations?.flowOf) await app.register(integrationRoutes({ flowOf: integrations.flowOf }));
}

async function registerCommerce(
    app: FastifyInstance,
    config: AppConfig,
    orgs: OrgRegistry,
    writer: CommercePlanWriter | undefined
): Promise<void> {
    if (config.commerce.enabled && writer) await app.register(commerceRoutes({ orgs, writer }));
}

/** No `listen` here — that split is what lets the route tests drive the app in-process. */
export async function buildApp({
    config,
    orgs,
    store,
    auth,
    orgOfLease,
    orgOfJob,
    orgOfReclaim,
    connectionOfLease,
    attemptOfLease,
    integrations,
    githubMint,
    githubRevoke,
    pairMatches,
    fetchFn,
    cloudIdLookup,
    destroyRevokedSecret,
    identity,
    appSlug,
    installationListing,
    commercePlanWriter,
    ready,
    version = readVersion(),
    now = Date.now,
    metrics,
    logger = false,
}: AppDeps): Promise<FastifyInstance> {
    const app = Fastify({ logger });

    const header = csp(config.webRoot === null);
    app.addHook('onSend', async (_request, reply) => {
        reply.header('Content-Security-Policy', header);
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header('Referrer-Policy', 'no-referrer');
    });

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
    if (auth) await registerAuth(app, { config, store: auth, orgOfLease, orgOfJob, orgOfReclaim });
    else app.decorateRequest('auth', null);

    await app.register(healthRoutes(ready));
    await app.register(versionRoutes(version));
    if (auth) {
        await app.register(authRoutes({ config, store: auth, orgs, identity, appSlug, installationListing }));
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
            await app.register(webhookRoutes({ store: auth, orgs, secret: config.webhookSecret }));
        }
    }
    await app.register(skillRoutes(skillCatalog));
    await app.register(statsRoutes(config, orgs, auth, now));
    await app.register(repoRoutes({ config, orgs }));
    if (store) await app.register(ingestRoutes(store, orgs));
    // The board and the workflow definitions it resolves against: per-org runtimes, the routes
    // answering 503 for an org the registry has no store for — the same bargain as the env routes.
    await app.register(jobRoutes({ orgs, ...(metrics ? { claimPoll: metrics.claimPoll } : {}) }));
    if (metrics) await app.register(prometheusRoutes(metrics));
    await app.register(taskRoutes({ orgs }));
    await app.register(workflowRoutes({ orgs }));
    // Batch plans (059): like the routes above, 503 for an org whose runtime carries no batch store.
    await app.register(batchRoutes({ orgs }));
    await app.register(envRoutes({ config, orgs }));
    // Managed connector connections (#546) and the runner-facing proxy that spends them.
    await app.register(
        connectionRoutes({
            orgs,
            destroyRevokedSecret: destroyRevokedSecret ?? integrations?.destroyRevokedSecret,
            ...(cloudIdLookup ? { lookupCloudId: cloudIdLookup } : {}),
        })
    );
    await registerRunnerCredentialRoutes(app, {
        orgs,
        connectionOfLease,
        attemptOfLease,
        pairMatches,
        integrations,
        githubMint,
        githubRevoke,
        fetchFn,
    });
    await app.register(workspaceRoutes({ orgs }));
    // Plans and usage (BEL-146): like the webhook, no route exists unless the deployment turned commerce on.
    await registerCommerce(app, config, orgs, commercePlanWriter);
    // Organization-scoped executor profiles (issue 391): the admins' CRUD beside the personal
    // routes, the same org-resolution the workflow routes make.
    await app.register(orgExecutorRoutes({ orgs }));
    // The member roster and its role writes (issue 410), the same person-shaped surface: the
    // caller's role decides, the store has no role of its own to check.
    if (auth) await app.register(orgMemberRoutes({ store: auth }));

    if (config.webRoot) {
        const { default: fastifyStatic } = await import('@fastify/static');
        await app.register(fastifyStatic, { root: config.webRoot });
        app.setNotFoundHandler(async (request, reply) => {
            if (request.url.startsWith('/api/')) return reply.code(HTTP_NOT_FOUND).send({ error: 'Not found' });
            return reply.sendFile('index.html');
        });
    }

    return app;
}
