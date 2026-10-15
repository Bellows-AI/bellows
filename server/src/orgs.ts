import type { Sql } from 'postgres';
import { createArtifactStore, type ArtifactStore } from './artifacts/artifact-store.js';
import type { ArtifactBackend } from './artifacts/backend.js';
import type { AppConfig } from './config.js';
import { createBatchMerger, type BatchMerger } from './batch-merger.js';
import { createBatchPrObserver, type BatchPrObserver } from './batch-pr-observer.js';
import { createBatchStore, type BatchStore } from './db/batch-store.js';
import { createConnectionStore, type ConnectionStore } from './db/connection-store.js';
import { createEnvVarStore, type EnvVarStore } from './db/env-var-store.js';
import { createJobStore } from './db/job-store.js';
import type { JobStore } from './db/job-store-types.js';
import { storedRepoNames } from './db/stored-repos.js';
import { createUserExecutorStore, type UserExecutorStore } from './db/user-executor-store.js';
import { createUserRepoStore, type UserRepoStore } from './db/user-repo-store.js';
import { createGitHubAppClient } from './github/app-client.js';
import { installationTokenProvider } from './github/app-token.js';
import { createRepoSource, type RepoSource } from './github/repo-source.js';
import { trackedRepos } from './db/tracked-repos.js';
import { createWorkflowStore, type WorkflowStore } from './db/workflow-store.js';
import { createPrLifecycleStore, type PrLifecycleStore } from './db/pr-lifecycle-store.js';
import { createStatsService, type StatsService } from './stats-service.js';
import { createPostgresTelemetryClient } from './telemetry/postgres-client.js';
import { createFixtureTelemetryClient, createNullTelemetryClient } from './telemetry/fixture-client.js';
import type { TelemetryClient } from './telemetry/client.js';
import { createCloneQueue, type CloneQueue } from './workspace/queue.js';
import { createPurger, type Purger } from './workspace/purge.js';
import { createFactsCache, type FactsCache } from './workspace/facts.js';
import { readGatesFile } from './workspace/bellows.js';

/**
 * Everything one organization needs at runtime, built lazily and cached.
 *
 * Since #99 the org is a property of the caller, but every store below still binds its org at
 * construction — that is their shape, and per-call org parameters would thread a column through
 * several hundred query sites for no second implementation. The registry is how both stay true:
 * construction happens PER ORG, on first request from one, and the result is cached for the life
 * of the process. The cache is safe unbounded because an org id IS an installation id — a stable
 * database key that is never re-pointed — and the population is bounded by the installations the
 * App has.
 */
export interface OrgRuntime {
    orgId: string;
    /** The org's own repo list: one cached installation client's answer, or the stored fallback. */
    repos: RepoSource;
    telemetry: TelemetryClient;
    /** The org's stats cache, over the org's repos and telemetry. */
    service: StatsService;
    /** Present in the live server; absent in route tests that pass no stores. */
    jobs?: JobStore | undefined;
    /** The workflow definitions (027) this org's tasks may walk; present with the other stores. */
    workflows?: WorkflowStore | undefined;
    /** The PR lifecycle (036): the thread's publication identity and its PR waits. */
    prs?: PrLifecycleStore | undefined;
    envVars?: EnvVarStore | undefined;
    /** The batch plans (059) the batch routes read and freeze; present with the other stores. */
    batches?: BatchStore | undefined;
    /** Reads each batch task's PR from GitHub and records the observations (063); present with the batch store. */
    batchObserver?: BatchPrObserver | undefined;
    /** Merges the PRs of automerge stages and verifies each merged stage (064); absent offline, where the board cannot merge. */
    batchMerger?: BatchMerger | undefined;
    /** A branch's tip through the org's installation, null when it cannot be read; absent offline. */
    branchHead?: ((repo: string, branch: string) => Promise<string | null>) | undefined;
    /** The artifact index over the object store (070): the org's chunks and manifests; present with the other stores. */
    artifacts?: ArtifactStore | undefined;
    /** The managed connector connections (054) a task may select; present with the other stores. */
    connections?: ConnectionStore | undefined;
    userRepos?: UserRepoStore | undefined;
    userExecutors?: UserExecutorStore | undefined;
    cloneQueue?: CloneQueue | undefined;
    /** The manual purge (issue #92): one member's orphaned checkout, deleted deliberately. */
    purger?: Purger | undefined;
    /**
     * The checkout facts cache, per org so the purger and the workspace routes share one instance:
     * a deleted tree's cached size must not answer for whatever is re-cloned into its path.
     */
    facts?: FactsCache | undefined;
}

export interface OrgRegistry {
    /** The runtime for an organization row, or null when no such row exists. */
    for(orgId: string): Promise<OrgRuntime | null>;
    /** Every organization row — the ingest resolver's matching set. */
    list(): Promise<{ id: string; name: string; installationId: string | null }[]>;
    /** Warms every existing org's stats cache, once migrations have landed. */
    warmAll(): Promise<void>;
    /** One scheduling pass over every org's open batches (docs/batches.md); one org's failure is logged, not thrown. */
    reconcileBatches(): Promise<void>;
    /** One observation pass, then one merge pass, over every org's batch PRs (docs/batches.md); one org's failure is logged, not thrown. */
    observeBatchPrs(): Promise<void>;
}

export interface OrgRegistryDeps {
    sql: Sql;
    ready: Promise<unknown>;
    config: AppConfig;
    /** False in the route-test mode: the stats routes resolve, the stores stay unregistered. */
    withStores: boolean;
    /**
     * The checkout facts cache. One per process in the live server — main.ts builds it and hands
     * the same instance to the registry and the app, because a purge must invalidate exactly the
     * cache the routes read. Absent (route tests) each org builds its own.
     */
    facts?: FactsCache;
    /** The object store behind each org's artifact index; absent (route tests), no org has one. */
    artifacts?: ArtifactBackend;
}

/** The per-org write-side stores, built only under `withStores` (#99's route-test bypass). */
function buildOrgStores({
    sql,
    orgId,
    ready,
    config,
    tokens,
    client,
    facts,
}: {
    sql: Sql;
    orgId: string;
    ready: Promise<unknown>;
    config: AppConfig;
    tokens: ReturnType<typeof installationTokenProvider> | undefined;
    client: ReturnType<typeof createGitHubAppClient> | undefined;
    facts: FactsCache;
}): {
    envVars: EnvVarStore;
    batches: BatchStore;
    batchObserver: BatchPrObserver;
    batchMerger: BatchMerger | undefined;
    connections: ConnectionStore;
    userExecutors: UserExecutorStore;
    userRepos: UserRepoStore;
    prs: PrLifecycleStore;
    cloneQueue: CloneQueue | undefined;
    purger: Purger | undefined;
    jobs: JobStore;
    workflows: WorkflowStore;
    facts: FactsCache;
} {
    const envVars = createEnvVarStore({ sql, orgId, ready });
    const connections = createConnectionStore({ sql, orgId, ready });
    const userExecutors = createUserExecutorStore({ sql, orgId, ready });
    const userRepos = createUserRepoStore({ sql, orgId, ready });
    // The PR lifecycle store: the webhook's fold/cancel sweep targets it, and the verdict
    // transaction records the thread's publication identity through it.
    const prs = createPrLifecycleStore({ sql, orgId, ready });
    const cloneQueue = config.workspaceRoot
        ? createCloneQueue({
              store: userRepos,
              root: config.workspaceRoot,
              orgId,
              tokens,
              log: (m) => console.log(`[workspace] ${m}`),
          })
        : undefined;
    const purger = config.workspaceRoot
        ? createPurger({
              store: userRepos,
              root: config.workspaceRoot,
              orgId,
              facts,
              log: (m) => console.log(`[workspace] ${m}`),
          })
        : undefined;
    const jobs = createJobStore({
        sql,
        orgId,
        hasWorkspaces: config.workspaceRoot !== null,
        ready,
        env: envVars,
        executorConfig: userExecutors,
        // Gates are read off the server's own workspace mount, per claim, for the job's
        // author and repo label — worktree-first, falling back to the clone.
        ...(config.workspaceRoot
            ? {
                  gates: {
                      readFor: (workspacePath: string, repo: string, worktreeId: string | null) =>
                          readGatesFile({ root: config.workspaceRoot!, workspacePath, repo, worktreeId }),
                  },
              }
            : {}),
        // The claim mints the org's installation token under the runner env as its base
        // layer. Per-org here is the whole point: a runner gets the installation of the
        // org whose board it is working, and no other.
        ...(tokens ? { githubToken: tokens } : {}),
        // The completion surface records the thread's publication identity in the same
        // transaction as the verdict (and cancel/remove sweep the thread's waits).
        prs,
    });
    // Batches (059, 060): dispatch creates task roots in the job table, settles a cancelled
    // batch through the job store's own stop and closes an ended batch's threads through its Done.
    // The attempt record names the target's head commit, resolved from the installation when there is one.
    const batches = createBatchStore({
        sql,
        orgId,
        ready,
        stop: (id, by) => jobs.stop(id, by),
        close: (id, by) => jobs.markDone(id, by),
        ...(client ? { revisionOf: (repo: string, branch: string) => client.readBranchHead(repo, branch) } : {}),
    });
    // The PR observer (063): reads the org's installation, records merges through the job store and
    // lets the gate judge them. Offline there is no client, so it only keeps rows and hints.
    const batchObserver = createBatchPrObserver({
        sql,
        orgId,
        ready,
        reader: client,
        recordMerge: (repo, prNumber, deliveryId, mergedAt) => jobs.closeMergedPr(repo, prNumber, deliveryId, mergedAt),
        reconcile: (batchId) => batches.reconcile(batchId),
    });
    // The merger (064): needs the installation to merge through; offline the board cannot merge and
    // refuses an automerge plan at start.
    const batchMerger = client
        ? createBatchMerger({
              sql,
              orgId,
              ready,
              client,
              recordMerge: (repo, prNumber, deliveryId, mergedAt) =>
                  jobs.closeMergedPr(repo, prNumber, deliveryId, mergedAt),
              reconcile: (batchId) => batches.reconcile(batchId),
          })
        : undefined;
    // Workflow definitions (027): the process a task walks, stored per scope inside this org.
    const workflows = createWorkflowStore({ sql, orgId, ready });
    return {
        facts,
        envVars,
        batches,
        batchObserver,
        batchMerger,
        connections,
        userExecutors,
        userRepos,
        prs,
        cloneQueue,
        purger,
        jobs,
        workflows,
    };
}

/**
 * Attaches the write-side stores to a runtime and starts its background work, in the one order
 * that matters: purge recovery is awaited (a row left `purging` is owned by a
 * process that no longer exists, and every workspace mutation and task insert refuses or
 * serializes behind a purging stamp — finishing each one here is what makes "boot recovery
 * before accepting mutations" true rather than aspirational; the single-process assumption is
 * 011's, extended by 044), THEN the clone queue starts (fired — recovering stranded clones is
 * minutes of network).
 */
async function attachOrgStores(runtime: OrgRuntime, stores: Awaited<ReturnType<typeof buildOrgStores>>): Promise<void> {
    runtime.facts = stores.facts;
    runtime.envVars = stores.envVars;
    runtime.batches = stores.batches;
    runtime.batchObserver = stores.batchObserver;
    runtime.batchMerger = stores.batchMerger;
    runtime.connections = stores.connections;
    runtime.userExecutors = stores.userExecutors;
    runtime.userRepos = stores.userRepos;
    runtime.cloneQueue = stores.cloneQueue;
    runtime.purger = stores.purger;
    runtime.jobs = stores.jobs;
    runtime.prs = stores.prs;
    runtime.workflows = stores.workflows;
    try {
        await stores.purger?.recoverInterrupted();
    } catch (e) {
        console.error(`[workspace] purge recovery failed: ${(e as Error).message}`);
    }
    void stores.cloneQueue?.start().catch((e: Error) => console.error(`[workspace] ${e.message}`));
}

/** The org's artifact index over the process's object store, or undefined when none was configured. */
function artifactStoreOf({
    sql,
    orgId,
    ready,
    config,
    backend,
}: {
    sql: Sql;
    orgId: string;
    ready: Promise<unknown>;
    config: AppConfig;
    backend: ArtifactBackend | undefined;
}): ArtifactStore | undefined {
    if (!backend) return undefined;
    return createArtifactStore({
        sql,
        orgId,
        ready,
        objects: backend.objects,
        prefix: backend.prefix,
        orgQuotaBytes: config.artifacts.orgQuotaBytes,
    });
}

export function createOrgRegistry({
    sql,
    ready,
    config,
    withStores,
    facts: sharedFacts,
    artifacts,
}: OrgRegistryDeps): OrgRegistry {
    const runtimes = new Map<string, Promise<OrgRuntime | null>>();

    const build = async (orgId: string): Promise<OrgRuntime | null> => {
        await ready;
        const rows = await sql<{ id: string; name: string; installation_id: string | null }[]>`
            select id, name, installation_id::text as installation_id from organization where id = ${orgId}
        `;
        const row = rows[0];
        if (!row) return null;

        // The repo-read credential, per org: minted from THIS org's installation, never a
        // process-wide one. Offline there is no App to mint from, and the stored fallback keeps
        // a seeded database browsable — the same bargain the single-org repo source made.
        let client: ReturnType<typeof createGitHubAppClient> | undefined;
        let tokens: ReturnType<typeof installationTokenProvider> | undefined;
        if (config.github.mode === 'app' && row.installation_id !== null) {
            tokens = installationTokenProvider({ github: config.github, installationId: row.installation_id });
            client = createGitHubAppClient(config.github, tokens);
        }

        const repos = createRepoSource({
            client,
            stored: () => storedRepoNames({ sql, orgId, ready }),
            // The onboarding screen's per-org choice (#125): the installation report intersected
            // with `tracked_repo`. Empty table = track everything, so a deployment that never
            // narrows reads exactly as it did before the screen existed.
            allowlist: () => trackedRepos({ sql, orgId, ready }),
        });

        const telemetry =
            config.telemetrySource === 'off'
                ? createNullTelemetryClient()
                : config.telemetrySource === 'fixture'
                  ? createFixtureTelemetryClient()
                  : createPostgresTelemetryClient({ sql, orgId, ready });

        const runtime: OrgRuntime = {
            orgId,
            repos,
            telemetry,
            service: createStatsService({ config, repos, telemetry }),
            ...(client ? { branchHead: (repo: string, branch: string) => client.readBranchHead(repo, branch) } : {}),
        };

        if (withStores) {
            // Per org unless the process shares one (main.ts passes it): the cache is keyed by
            // full path, so sharing is safe, and sharing is what lets a purge invalidate the
            // instance the routes read.
            const facts = sharedFacts ?? createFactsCache();
            const stores = buildOrgStores({ sql, orgId, ready, config, tokens, client, facts });
            await attachOrgStores(runtime, stores);
            runtime.artifacts = artifactStoreOf({ sql, orgId, ready, config, backend: artifacts });
        }

        return runtime;
    };

    return {
        for(orgId) {
            let runtime = runtimes.get(orgId);
            if (!runtime) {
                runtime = build(orgId)
                    .then((built) => {
                        // Do not cache a MISS either: `for` is called with principal-carried ids
                        // (FK-guaranteed today), but a caller that asks before the org row lands
                        // would otherwise remember null for the process's whole life.
                        if (built === null) runtimes.delete(orgId);
                        return built;
                    })
                    .catch((e: Error) => {
                        // Do not cache a failure either: the next request retries, and the log
                        // line is what tells the operator which org could not be built.
                        console.error(`[org] runtime for "${orgId}" failed: ${e.message}`);
                        runtimes.delete(orgId);
                        return null;
                    });
                runtimes.set(orgId, runtime);
            }
            return runtime;
        },

        async list() {
            await ready;
            const rows = await sql<{ id: string; name: string; installation_id: string | null }[]>`
                select id, name, installation_id::text as installation_id from organization order by name
            `;
            return rows.map((row) => ({ id: row.id, name: row.name, installationId: row.installation_id }));
        },

        async warmAll() {
            await ready;
            // In parallel: the whole point is to beat the first visitor to the cold read, and a
            // cold `for()` is a real build — serialising them hands org #2 onward the very wait
            // this exists to remove. `for` never rejects (it logs and answers null), so one
            // broken org cannot take the sweep down with it.
            await Promise.all(
                (await this.list()).map(async (org) => {
                    const rt = await this.for(org.id);
                    rt?.service.ensureFresh();
                })
            );
        },

        async reconcileBatches() {
            await ready;
            await Promise.all(
                (await this.list()).map(async (org) => {
                    try {
                        await (await this.for(org.id))?.batches?.reconcileOpen();
                    } catch (e) {
                        console.error(`[batches] reconcile for "${org.id}" failed: ${(e as Error).message}`);
                    }
                })
            );
        },

        async observeBatchPrs() {
            await ready;
            await Promise.all(
                (await this.list()).map(async (org) => {
                    try {
                        const runtime = await this.for(org.id);
                        // Observe first: a merge decision is only as good as the observation it reads.
                        await runtime?.batchObserver?.observeDue().finally(() => runtime?.batchMerger?.mergeDue());
                    } catch (e) {
                        console.error(`[batches] observe for "${org.id}" failed: ${(e as Error).message}`);
                    }
                })
            );
        },
    };
}
