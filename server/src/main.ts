import { jiraApiBase } from '@factory-ai/core';
import postgres, { type Sql } from 'postgres';
import { buildApp } from './app.js';
import { callbackPath, createGitHubIdentityClient } from './auth/github.js';
import { createAuthStore } from './auth/store.js';
import { type AppConfig, resolveConfig, type GitHubConfig, type JiraOAuthConfig } from './config.js';
import { LOCAL_ORG_ID } from './identifiers.js';
import { createAttemptOfLease, createPairMatches } from './db/attempt-of-lease.js';
import { liveOAuthConnectionsOf } from './db/connection-bindings.js';
import { createOperationReceipts } from './db/operation-receipts.js';
import { createOrgOfJob, createOrgOfLease, createOrgOfReclaim } from './db/jobs/job-store-org-resolvers.js';
import { createAppSlugProvider } from './github/app-token.js';
import { startBatchPrObserver } from './batch-pr-observer.js';
import { startBatchReconciler } from './batch-reconciler.js';
import { type ArtifactBackend, createArtifactBackend, prepareArtifactBackend } from './artifacts/backend.js';
import { admissionOccupancy } from './db/jobs/job-store-admission.js';
import { createServerMetrics, type ServerMetrics } from './metrics.js';
import { createOrgRegistry, type OrgRegistry } from './orgs.js';
import type { GithubMint, GithubRevoke } from './routes/github-credential.js';
import { createPostgresStore } from './telemetry/store.js';
import { migrate } from './db/migrate.js';
import {
    createIntegrationRuntime,
    recoverIntegrations,
    startIntegrationRecovery,
} from './integrations/integration-recovery.js';
import { jiraRegistration } from './integrations/providers/jira.js';
import { startAttachmentSweep } from './attachments/attachment-collector.js';
import { startSecretCollector } from './secrets/secret-collector.js';
import { startCommerceDelivery } from './commerce/commerce-loop.js';
import { startNotificationDelivery } from './notifications/delivery-loop.js';
import { productionConnectors } from './notifications/registry.js';
import { createCommercePlanWriter } from './db/commerce-plan-writer.js';
import { createSecretStore, loadSecretBackend } from './secrets/secret-backend.js';
import type { SecretDiagnostic } from './secrets/secret-store.js';

/** One registry: the subscription routes validate against it and delivery sends through it. */
const connectors = productionConnectors();

/**
 * The outbox deliveries run on every replica: closed claims go to the commerce service, off by default
 * (docs/commerce.md); notification rows go through `connectors`, on whenever a public URL is configured (docs/notifications.md).
 */
function startDeliveries({
    config,
    orgs,
    metrics,
    ready,
}: {
    config: AppConfig;
    orgs: OrgRegistry;
    metrics: ServerMetrics;
    ready: Promise<unknown>;
}): void {
    startCommerceDelivery({ commerce: config.commerce, orgs, metrics, ready });
    startNotificationDelivery({ connectors, publicUrl: config.integrations.callbackOrigin, orgs, metrics, ready });
}

/**
 * The garbage collectors run on every replica: unreferenced secret versions and finished operations; abandoned
 * uploads and the files of a removed task. Each delete re-checks its own guard.
 */
function startCollectors({
    sql,
    ready,
    secrets,
    artifacts,
    config,
    metrics,
}: {
    sql: Sql;
    ready: Promise<unknown>;
    secrets: { collect(): Promise<unknown> };
    artifacts: ArtifactBackend;
    config: AppConfig;
    metrics: ServerMetrics;
}): void {
    void ready.then(() =>
        startSecretCollector({ collect: () => metrics.timedPass('secret_collect', () => secrets.collect()) })
    );
    void ready.then(() => startAttachmentSweep({ sql, ready, artifacts, config: config.artifacts, metrics }));
}

/** The attempt checks behind the runner credential routes, and the lanes' optional mint and revoke stand-ins. */
const runnerCredentialDeps = (
    db: { sql: Sql; ready: Promise<unknown> },
    options: StartOptions,
    jira: JiraOAuthConfig | null
) => ({
    attemptOfLease: createAttemptOfLease(db),
    pairMatches: createPairMatches(db),
    operationReceipts: createOperationReceipts(db),
    // The runner helper's connection list: Jira only, and only while the provider is configured.
    connectionListing: {
        connectionsOf: async (orgId: string, rootJobId: string) => {
            await db.ready;
            return liveOAuthConnectionsOf(db.sql, orgId, rootJobId);
        },
        apiBaseOf: (provider: string, resource: string) =>
            provider === 'jira' && jira ? jiraApiBase(jira.apiOrigin, resource) : null,
    },
    githubMint: options.githubMint,
    githubRevoke: options.githubRevoke,
});

interface StartOptions {
    github?: GitHubConfig;
    githubMint?: GithubMint;
    githubRevoke?: GithubRevoke;
}

/**
 * The whole wiring, from config to `listen`. Every entry is this function plus one decision about
 * GitHub: `index.ts` reads the environment, which can only ever produce the App; `offline.ts`
 * passes the code-only `none` arm for the harnesses that run with no credential and no network, and
 * `offline-mint.ts` adds the lanes' stand-in runner-token mint to it.
 */
export async function start(options: StartOptions = {}): Promise<void> {
    const { config } = resolveConfig({ env: process.env, ...(options.github ? { github: options.github } : {}) });
    // The orgs are the App's installations now (#99) — the process is bound to none of them, which
    // is the point. The mode is what a boot should say out loud.
    console.log(
        config.auth.mode === 'github'
            ? '[org] organizations are GitHub App installations, materialized at sign-in'
            : `[org] ${LOCAL_ORG_ID} (local — AUTH_MODE=none)`
    );

    if (config.github.mode === 'app') {
        console.log(`[fetch] GitHub App ${config.github.appId}; installation tokens are minted per organization`);
        // Loud, for the reason the OAuth authorize URL is: an API host that could be redirected in a
        // file shipping with a deployment is somewhere to send a private key, so the only defence is
        // that using one is impossible to miss in the log.
        if (config.github.apiUrl !== 'https://api.github.com') {
            console.warn(`[fetch] NOT using api.github.com: API URL is ${config.github.apiUrl}`);
        }
    } else {
        console.log('[fetch] no GitHub credential: serving stored data only, nothing will be fetched or cloned');
    }

    // Required on every boot, offline included: a dashboard that cannot decrypt must not come up and
    // look healthy. The backend (database, aws) is chosen by SECRETS_BACKEND, which has no default. Throws a
    // message naming the variable, never its value. Read here and handed to the store only, so the keys
    // and provider settings never ride the config into the routes (docs/secrets.md).
    const secretBackend = loadSecretBackend(process.env);

    // One pool, and one `migrate()`, for every feature sharing the schema. Two runners would
    // race each other.
    const sql = postgres(config.databaseUrl, { max: config.dbPoolMax });
    // NOT awaited. Migrations retry with backoff for the better part of a minute while the database
    // container starts, and blocking here would hold the whole dashboard hostage to it. Every consumer
    // gates its own queries on `ready` and reports unavailable until then.
    //
    // Under AUTH_MODE=none it also seeds the local organization and the stand-in account every
    // request is attributed to. Github mode seeds nothing: sign-in materializes the orgs.
    const ready = migrate(sql, {
        localUser: config.auth.mode === 'none',
        log: (m) => console.log(`[migrate] ${m}`),
    });
    ready.catch((e: Error) => console.error(`[migrate] giving up: ${e.message}`));

    // The store opens its own transactions, and the claim resolves environment secrets while holding one
    // pooled connection of its own: on a shared pool, `dbPoolMax` concurrent claims would each hold the
    // connection another's store call is waiting for. A pool of its own (connections open lazily, so an
    // idle one costs nothing) means a store call never borrows a claim's pool (docs/secrets.md).
    const secretSql = postgres(config.databaseUrl, { max: config.dbPoolMax });
    const secretLog = (d: SecretDiagnostic) => console.log(`[secrets] ${JSON.stringify(d)}`);
    const secrets = createSecretStore({
        sql: secretSql,
        ready,
        backend: secretBackend,
        log: secretLog,
    });

    // The ingest route's write side exists whenever there is somewhere to put an export — which is
    // always, unless telemetry is switched off outright. The store takes the org per report from
    // the credential verified at the auth hook — never from the report's repo, which is
    // caller-controlled payload and used to be a cross-tenant write into another installation's
    // telemetry (CWE-862).
    const store = config.telemetrySource === 'postgres' ? createPostgresStore({ sql }) : undefined;

    console.log(`[persist] ${config.databaseUrl.replace(/\/\/[^@]*@/, '//')}`);

    // Everything per-org is built lazily from here, on the first request that names an org.
    // The workflow definitions (027) ride the same per-org runtimes, created with the org's id.
    //
    const artifacts = createArtifactBackend(config.artifacts);
    void prepareArtifactBackend(artifacts, (m) => console.log(`[artifacts] ${m}`));
    // Prometheus series for the board (issue #831): the claim reports into them, `GET /api/metrics`
    // serves them, and the background loops below are wrapped with `metrics.timedPass`.
    const metrics = createServerMetrics({
        admission: config.admission,
        occupancy: (signal) => admissionOccupancy(sql, { signal }),
    });
    const orgs = createOrgRegistry({
        sql,
        ready,
        config,
        withStores: true,
        secrets,
        secretLog,
        artifacts,
        claimMetrics: metrics.claim,
    });

    // Unconditional, for the same reason the job store is: the database is mandatory, so there is
    // always somewhere for accounts to live. buildApp's optional `auth` is for the route tests.
    const authStore = createAuthStore({ sql, ready });
    const identity = config.auth.mode === 'github' ? createGitHubIdentityClient(config.auth) : undefined;

    if (config.auth.mode === 'github') {
        console.log(`[auth] GitHub sign-in, callback ${config.auth.publicUrl}${callbackPath}`);
        console.log('[auth] worker routes take Bearer $JOB_BOARD_TOKEN — the same value the driver holds');
        console.log(
            '[auth] the App setup URL must point at the /api/auth/github/setup route for the install round trip'
        );
        if (!config.auth.cookieSecure) {
            console.log('[auth] cookie_secure is off: the session cookie will travel over plain http');
        }
        // Loud, because a configurable authorize URL that reached a real deployment would be a phishing
        // vector, and the only defence against that is it being impossible to miss in the log.
        if (config.auth.authorizeUrl !== 'https://github.com/login/oauth/authorize') {
            console.warn(`[auth] NOT using github.com: authorize URL is ${config.auth.authorizeUrl}`);
        }
    } else {
        // Unconditional and blunt, in the register of the "[fetch] no GitHub credential" line above:
        // the whole point of AUTH_MODE being an explicit enum is that nobody arrives here by accident,
        // and the line is what makes staying here a choice too.
        console.log(
            '[auth] AUTH_MODE=none: every route is open to anyone who can reach this port, including POST /api/jobs, which runs shell commands'
        );
    }

    // The outbound OAuth runtime (BEL-138). Jira registers when ATLASSIAN_CLIENT_ID/SECRET are set; unset, no provider is
    // configured and the runtime serves only the recovery of rows and the destroy of a revoked grant's secret.
    const jira = jiraRegistration(config.integrations.jira);
    const integrations = createIntegrationRuntime({
        sql,
        secrets,
        providers: jira.providers,
        clients: jira.clients,
        callbackOrigin: config.integrations.callbackOrigin,
        log: (d) => console.log(`[integrations] ${JSON.stringify(d)}`),
    });

    const app = await buildApp({
        config,
        orgs,
        ready,
        notificationConnectors: connectors,
        store,
        secrets,
        integrations,
        auth: authStore,
        // The branch route's runner credential: the job id + lease token pair a reporter presents
        // resolves to the org whose attempt it is. Built from the job store's SQL — the one
        // org-less job query, because the pair's answer IS the org. The worker-route resolvers
        // beside it are the same direction: the shared board secret authenticates the driver, and
        // the org a call operates on comes from the row its URL names.
        orgOfLease: createOrgOfLease({ sql, ready }),
        orgOfJob: createOrgOfJob({ sql, ready }),
        orgOfReclaim: createOrgOfReclaim({ sql, ready }),
        ...runnerCredentialDeps({ sql, ready }, options, config.integrations.jira),
        commercePlanWriter: createCommercePlanWriter({ sql, ready }),
        identity,
        appSlug: config.github.mode === 'app' ? createAppSlugProvider({ github: config.github }).slug : undefined,
        metrics,
        logger: true,
    });

    // Warm every known org's cache at boot so the first visitor does not eat the cold read. Fired,
    // not awaited: a cold database must not hold `listen()`.
    void ready.then(() => orgs.warmAll()).catch((e: Error) => console.error(`[orgs] warm failed: ${e.message}`));

    // Dispatch survives a missed callback or a restart: the first pass runs now, then on an interval.
    void ready.then(() =>
        startBatchReconciler({
            reconcileBatches: () => metrics.timedPass('batch_reconcile', () => orgs.reconcileBatches()),
        })
    );
    // PR checks and mergeability are read from GitHub on a cadence; webhooks only hint (docs/batches.md).
    void ready.then(() =>
        startBatchPrObserver({
            observeBatchPrs: () => metrics.timedPass('batch_pr_observe', () => orgs.observeBatchPrs()),
        })
    );

    startCollectors({ sql, ready, secrets, artifacts, config, metrics });

    // What a lost board pod left mid-exchange or mid-persistence is adopted on every replica; each row is re-checked.
    void ready.then(() =>
        startIntegrationRecovery((signal) =>
            metrics.timedPass('integration_recover', () => recoverIntegrations(integrations, { signal }))
        )
    );

    startDeliveries({ config, orgs, metrics, ready });

    await app.listen({ port: config.port, host: config.host });
}
