import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyServerOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { requirementFor } from '../src/auth/plugin.js';
import { SESSION_COOKIE } from '../src/auth/session.js';
import type { AuthConfig } from '../src/config.js';
import type { Job } from '../src/db/jobs/job-store-types.js';
import type { JobStore } from '../src/db/jobs/job-store-types.js';
import type { AppDeps } from '../src/app.js';
import { staticRepoSource } from '../src/github/repo-source.js';
import type { OrgRegistry } from '../src/orgs.js';
import { batchRoutes } from '../src/routes/batches/batches.js';
import { readVersion } from '../src/version.js';
import type { MemoryAuthStore } from './helpers.js';
import {
    buildWithAuth,
    githubAuth,
    makeClaim,
    memoryAuthStore,
    signedIn,
    staticRegistry,
    stubTelemetryClient,
    testConfig,
    TEST_JOB_BOARD_TOKEN,
    telemetryStoreStub,
} from './helpers.js';
import {
    HTTP_ACCEPTED,
    HTTP_CONFLICT,
    HTTP_CREATED,
    HTTP_FORBIDDEN,
    HTTP_NOT_FOUND,
    HTTP_OK,
    HTTP_SERVICE_UNAVAILABLE,
    HTTP_UNAUTHORIZED,
    trackApps,
} from './helpers-http.js';

// Every instance Fastify creates records each route it is handed, so the full app's patterns can be read back.
const registered = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock('fastify', async (importOriginal) => {
    const original = await importOriginal<typeof import('fastify')>();
    const wrapped = ((options?: FastifyServerOptions) => {
        const instance = original.default(options);
        instance.addHook('onRoute', (route) => {
            registered.urls.push(route.url);
        });
        return instance;
    }) as typeof original.default;
    return { ...original, default: wrapped };
});

const ORG = 'test-org';
const JOB_ID = '11111111-1111-4111-8111-111111111111';
const LEASE = '22222222-2222-4222-8222-222222222222';
const WORKER_TOKEN = TEST_JOB_BOARD_TOKEN;

const track = trackApps();

const jobStub = (overrides: Partial<JobStore> = {}): JobStore =>
    ({
        async askQuestion() {
            return { result: 'lost' };
        },
        async answerQuestion() {
            return { result: 'refused', reason: 'closed' };
        },
        async create() {
            return { id: JOB_ID };
        },
        async claim() {
            return makeClaim({ id: JOB_ID, command: 'echo hi', leaseToken: LEASE });
        },
        async heartbeat() {
            return { result: 'ok', leaseExpiresAt: '2026-08-21T12:05:00.000Z' };
        },
        async session() {
            return 'ok';
        },
        async suspend() {
            return { result: 'ok', status: 'stopped' };
        },
        async complete() {
            return 'ok';
        },
        async get() {
            return null as Job | null;
        },
        async thread() {
            return [] as Job[];
        },
        async list() {
            return [];
        },
        ...overrides,
    }) as JobStore;

async function build(
    auth: AuthConfig,
    store: MemoryAuthStore,
    orgOfLease?: AppDeps['orgOfLease'],
    // When set, the registry answers null for every org id outside it — the production shape,
    // where an org that does not exist resolves to nothing.
    orgsFor?: readonly string[]
) {
    const app = await buildWithAuth(
        auth,
        store,
        { jobs: jobStub(), repos: staticRepoSource([{ owner: 'acme', name: 'web' }]), ...(orgsFor ? { orgsFor } : {}) },
        {
            // The attempt-scoped pair the runner's branch reporter presents. Default: the one live
            // attempt the constants below describe; a test passes its own to model a lost lease.
            orgOfLease:
                orgOfLease ?? (async (jobId, leaseToken) => (jobId === JOB_ID && leaseToken === LEASE ? ORG : null)),
            // The worker routes' org resolvers: the one job the constants describe, nothing else.
            orgOfJob: async (jobId) => (jobId === JOB_ID ? ORG : null),
            orgOfReclaim: async (reclaimId) => (reclaimId === JOB_ID ? ORG : null),
        }
    );
    track(app);
    return app;
}

/*
 * Driven off requirementFor rather than restated, so this cannot drift from the hook. The point of
 * the table is that each answer is a decision, and three of them are load-bearing: health must stay
 * open or the compose healthcheck restarts a container that was about to succeed; the SPA's document
 * must stay open or there is nothing to render a sign-in button in; and the worker routes must NOT
 * accept a session, or any member could steal another worker's lease.
 */
const BATCH_PATHS: readonly (readonly [string, string])[] = [
    ['POST', '/api/batches'],
    ['GET', '/api/batches'],
    ['GET', `/api/batches/${JOB_ID}`],
    ['GET', `/api/batches/${JOB_ID}/report`],
    ['PUT', `/api/batches/${JOB_ID}`],
    ['POST', `/api/batches/${JOB_ID}/validate`],
    ['POST', `/api/batches/${JOB_ID}/start`],
    ['POST', `/api/batches/${JOB_ID}/cancel`],
    ['POST', `/api/batches/${JOB_ID}/tasks/a/retry`],
    ['POST', `/api/batches/${JOB_ID}/tasks/a/accept`],
];

// The person routes outside the job board and the batches: settings, workflows and the task read
// model. Each falls through to `user` by the safe default rather than being listed anywhere.
const PERSON_ROUTES: readonly (readonly [string, string])[] = [
    ['GET', '/api/env'],
    ['PUT', '/api/env/workspace'],
    ['GET', '/api/org/executors'],
    ['POST', '/api/org/executors'],
    ['GET', '/api/org/members'],
    ['PUT', `/api/org/members/${JOB_ID}/role`],
    ['GET', '/api/workflows'],
    ['POST', '/api/workflows'],
    ['GET', `/api/workflows/${JOB_ID}`],
    ['PUT', `/api/workflows/${JOB_ID}`],
    ['GET', '/api/workflow-blocks'],
    // The task read model (#157): a person's inbox view over the same board. A worker token
    // reading every task summary of the board would be the thread-read hole again, one level up.
    ['GET', '/api/tasks'],
    ['GET', '/api/workspace'],
    ['PUT', '/api/workspace/repos'],
    ['DELETE', '/api/workspace/repos/acme/web'],
    ['GET', '/api/workspace/executors'],
    ['PUT', '/api/workspace/executors'],
];

const ROUTE_TABLE: readonly (readonly [string, string])[] = [
    ['/api/health', 'open'],
    // The kubelet's startup probe carries no credential.
    ['/api/ready', 'open'],
    // Public build metadata, read by a probe or support person with no credential.
    ['/api/version', 'open'],
    ['/api/auth/github', 'open'],
    // The installation webhook answers to the HMAC signature over its body — a credential the
    // route verifies itself — so the session hook must not demand a cookie of it.
    ['/api/github/webhook', 'open'],
    ['/api/auth/github/callback', 'open'],
    // The onboarding screen's read and write (#125): the pending cookie IS the credential
    // here — these run before any session exists, which is the whole point of the step.
    ['/api/auth/github/pending', 'open'],
    ['/api/auth/github/pending/installations/123/repos', 'open'],
    ['/api/auth/github/complete', 'open'],
    ['/api/auth/me', 'open'],
    ['/', 'open'],
    ['/index.html', 'open'],
    ['/assets/app-1234.js', 'open'],
    // A client-side route, and the reason it is here is that it fails ONLY in production: Vite
    // has its own history fallback in dev, so a wall on this path would be invisible until the
    // baked image served it. The not-found handler in app.ts sends index.html for it, and the
    // wall is on /api/* rather than on the document — see docs/auth.md.
    ['/settings/workspace', 'open'],
    ['/api/stats', 'user'],
    ['/api/jobs', 'user'],
    ['/api/jobs/:id', 'user'],
    // All three are person's actions on a finished task — a follow-up asks for adjustments,
    // retry re-runs the thread head's command fresh, done declares the task finished by
    // hand — and all fall through to 'user'.
    ['/api/jobs/:id/follow-up', 'user'],
    ['/api/jobs/:id/retry', 'user'],
    // The owner binds a connection of their own to the thread (BEL-59): a person's action, never a worker's.
    ['/api/jobs/:id/connections', 'user'],
    // The same owner declines a provider the thread asked for; the runner's own ask is a worker route.
    ['/api/jobs/:id/requirements/:provider/dismiss', 'user'],
    ['/api/jobs/:id/requirements', 'worker'],
    ['/api/jobs/:id/done', 'user'],
    // Reopen (issue #327) is done's inverse and a person's verdict the same way: a worker
    // token un-closing tasks it never held would move audit rows for no run it owns.
    ['/api/jobs/:id/reopen', 'user'],
    // Stop and remove are person's actions too. The driver is told to stop through the
    // heartbeat it already holds, never through a stop route of its own; and a worker token
    // removing the audit rows of jobs it never held would be the thread-read hole (#47) again.
    ['/api/jobs/:id/stop', 'user'],
    ['/api/jobs/:id/remove', 'user'],
    // Both control a thread parked on a durable PR wait (issue #328) — person's actions on
    // the wait a worker holds no lease on, so they fall through to 'user' like the above.
    ['/api/jobs/:id/wait/cancel', 'user'],
    ['/api/jobs/:id/wait/poke', 'user'],
    ['/api/jobs/claim', 'worker'],
    // The Prometheus scrape (#831): the shared board secret, never a session.
    ['/api/metrics', 'worker'],
    // The orphan reaper's batched lease lookup (issue #301): org-less like the claim, and
    // read-only — a worker token answers facts, it never moves rows.
    ['/api/jobs/leases', 'worker'],
    // The worktree-reclaim queue POST /remove feeds: the driver polls it and acks each
    // reclaim, so both ends are as worker-only as claim and complete.
    ['/api/reclaims/claim', 'worker'],
    ['/api/reclaims/:id/ack', 'worker'],
    ['/api/reclaims/:id/renew', 'worker'],
    ['/api/jobs/:id/heartbeat', 'worker'],
    ['/api/jobs/:id/session', 'worker'],
    ['/api/jobs/:id/suspend', 'worker'],
    ['/api/jobs/:id/interrupt', 'worker'],
    ['/api/jobs/:id/complete', 'worker'],
    // The staged final envelope (issue #821): the same body as complete, under the same lease.
    ['/api/jobs/:id/conclusion', 'worker'],
    ['/api/jobs/:id/phase-checkpoint', 'worker'],
    ['/api/jobs/:id/phase-checkpoints', 'worker'],
    // The gate-run record (issue #983): the driver's own writes and its one read, under the lease.
    ['/api/jobs/:id/gate-run', 'worker'],
    ['/api/jobs/:id/gate-runs', 'worker'],
    // One row per managed PR operation (issue #983), written by the driver under the lease.
    ['/api/jobs/:id/pr-operation', 'worker'],
    ['/api/jobs/:id/output', 'worker'],
    // Both are the driver's gate machinery — the state reports after each gate runs and the
    // post-sync re-read of '.bellows.yaml'. Missing from this table is what left the last run's
    // gate state unstored: under AUTH_MODE=github both fell through to 'user' and answered the
    // worker token 401, while the gates themselves ran and passed unseen.
    ['/api/jobs/:id/gates', 'worker'],
    // The agent's questions (050, issue #531): the driver reports a question and expires it under
    // its lease; the member's answer is a person's act, so it falls through to 'user' — and is
    // outside the org-token allowlist.
    ['/api/jobs/:id/question', 'worker'],
    ['/api/jobs/:id/questions/:questionId/answer', 'user'],
    // A named reviewer's separate run (056, issue #549): the driver's request and its read of the
    // verdict, both under the caller's lease — worker routes, never a person's or an org token's.
    ['/api/jobs/:id/review', 'worker'],
    ['/api/jobs/:id/review-read', 'worker'],
    ['/api/jobs/:id/artifact/chunk', 'worker'],
    ['/api/jobs/:id/artifact/manifest', 'worker'],
    // The restore reads (issue #775): the thread's checkpoint and raw transcripts, under the live lease.
    ['/api/jobs/:id/checkpoint', 'worker'],
    ['/api/jobs/:id/checkpoint/chunk', 'worker'],
    ['/api/jobs/:id/transcripts', 'worker'],
    ['/api/jobs/:id/transcripts/chunk', 'worker'],
    // The thread read is a person's again: it carries commands, output and session ids of the
    // WHOLE thread, and a worker token on it could read the audit trail of jobs it never held.
    // The driver's one use for it (the worktree-reclaim terminality, issue #47) rides the
    // lease-guarded complete response as 'threadDone' instead.
    ['/api/jobs/:id/thread', 'user'],
    // The person-side read of a run: its activity. A worker token reading it would be the
    // thread-read hole again, one route over.
    ['/api/jobs/:id/activity', 'user'],
    ['/api/jobs/:id/artifacts', 'user'],
    ['/api/jobs/:id/artifacts/read', 'user'],
    // The Jira proxy is gone (BEL-61): nothing under /connectors/ takes the attempt pair any more, so the path is an
    // unmatched person-side URL like any other and answers 404 unauthenticated-or-not.
    ['/api/jobs/:id/connectors/jira/rest/api/3/myself', 'user'],
    // The runner's GitHub credential (docs/connections.md): the same class — the attempt's pair in
    // every mode, asked by the runner's helper and the driver's supervised steps alike.
    ['/api/jobs/:id/credentials/github', 'connector'],
    // Revoking that token at the end of the attempt: the same class, and a pair-only match on the board.
    ['/api/jobs/:id/credentials/github/revoke', 'connector'],
    // The managed-connection broker (BEL-60): the same class, one segment deeper.
    ['/api/jobs/:id/credentials/connections/:connectionId', 'connector'],
    // The runner seam (BEL-61): the helper's connection list and its durable operation receipts, the same class.
    ['/api/jobs/:id/credentials/connections', 'connector'],
    ['/api/jobs/:id/operations', 'connector'],
    ['/api/jobs/:id/operations/:receiptId', 'connector'],
    // Managing connections is a person's settings act; it falls through to 'user'.
    ['/api/connections', 'user'],
    ['/api/connections/:id', 'user'],
    // Starting and finishing an outbound OAuth connect is a person's act in their own browser session.
    ['/api/integrations/:provider/authorizations', 'user'],
    ['/api/integrations/:provider/callback', 'user'],
    ['/api/otlp/v1/logs', 'ingest'],
    // BEL-146: a member reads their org's plan; the commerce service's push has its own credential class,
    // and the anchored pattern gives nothing else under /api/commerce that class.
    ['/api/commerce', 'user'],
    ['/api/commerce/orgs/:orgId/plan', 'commerce'],
    ['/api/commerce/orgs/:orgId/plan/x', 'user'],
    ['/api/commerce/orgs/:orgId', 'user'],
    // The branch write stopped being an ingest-token route on purpose (CWE-862): the report's
    // repo must never choose the org it lands in, so the credential does. Its own requirement,
    // between worker and ingest — the pair is the attempt's, the bearer a member's.
    ['/api/sessions/branch', 'branch'],
    // Both fall through to 'user' rather than being listed anywhere, which is the point: the
    // default is the safe one, so a new route is walled unless somebody deliberately opens it.
    ['/api/repos', 'user'],
    ['/api/skills', 'user'],
    // Access-token management: a person's settings act, so session cookie or personal bearer —
    // never a worker token, and an org token is 403'd by the hook (not on its allowlist).
    ['/api/tokens', 'user'],
    ['/api/tokens/org', 'user'],
    ['/api/tokens/:id/revoke', 'user'],
    // Batches are a person's: no batch path is a worker route or on the organization-token allowlist.
    ...BATCH_PATHS.map(
        ([, path]) => [path.replace(JOB_ID, ':id').replace('/tasks/a/', '/tasks/:key/'), 'user'] as [string, string]
    ),
    // The person routes, as registered patterns (the concrete PERSON_ROUTES paths below drive inject).
    ...[
        '/api/tokens/org/:id/revoke',
        '/api/workflows/:id',
        '/api/env/org',
        '/api/env/repo',
        '/api/workspace/executors/default',
        '/api/workspace/executors/:id',
        '/api/workspace/executors/:id/suspension',
        '/api/org/executors/:id',
        '/api/org/executors/:id/suspension',
        '/api/org/executors/:id/scope',
        '/api/org/members/:userId/role',
    ].map((path) => [path, 'user'] as [string, string]),
    ['/api/otlp/v1/metrics', 'ingest'],
    ...[...new Set(PERSON_ROUTES.map(([, path]) => path))].map((path) => [path, 'user'] as [string, string]),
];

describe('the route table', () => {
    it.each(ROUTE_TABLE)('classifies %s as %s', (path, expected) => {
        expect(requirementFor(path)).toBe(expected);
    });

    // The table is hand-written beside the regex, which is how gates and artifact each slipped
    // through: a worker-shaped handler, absent from both, failing quietly
    // because its caller treats the answer as best-effort. Every route the job board registers
    // must be a decision recorded above.
    it('has a row for every route the full app registers', async () => {
        registered.urls.length = 0;
        const store = memoryAuthStore();
        const config = testConfig({
            auth: githubAuth(),
            webRoot: tmpdir(),
            commerce: { enabled: true, url: 'https://commerce.example/', token: 'commerce-token-0123456789abcdef-xyz' },
        });
        const app = track(
            await buildApp({
                config,
                orgs: staticRegistry({ config, telemetry: stubTelemetryClient() }),
                store: telemetryStoreStub(),
                auth: store,
                commercePlanWriter: { put: async () => ({ verdict: 'stored' }) },
                // The runner credential routes exist exactly when their per-call check does.
                attemptOfLease: async () => ({ ok: false }),
                pairMatches: async () => ({ ok: false }),
                integrations: {
                    flowOf: () => ({
                        startAuthorization: async () => ({ ok: false as const, reason: 'unknown-provider' as const }),
                        completeAuthorization: async () => ({
                            ok: false as const,
                            returnTo: '/',
                            failure: 'state-mismatch' as const,
                        }),
                        recoverAuthorization: async () => 'idle' as const,
                    }),
                    resolverOf: () => ({
                        resolveCredential: async () => ({
                            ok: false as const,
                            outcome: { outcome: 'forbidden' as const, reason: 'principal-mismatch' as const },
                        }),
                    }),
                },
            })
        );
        await app.ready();
        const patterns = new Set(registered.urls);
        const tabled = new Set(ROUTE_TABLE.map(([path]) => path));
        // A document route (the static handler's wildcard, the SPA root) is open on purpose.
        const documents = new Set(['/', '/*']);
        const missing = [...patterns].filter((pattern) => !tabled.has(pattern) && !documents.has(pattern));
        expect(patterns.size).toBeGreaterThan(0);
        expect(missing).toEqual([]);
        // Every worker and connector pattern names its row `:id`, which the hook reads from the router's params.
        const rowed = [...patterns].filter(
            (p) => ['worker', 'connector'].includes(requirementFor(p)) && /:\w+/.test(p)
        );
        expect(rowed.filter((p) => !/^\/api\/(jobs|reclaims)\/:id(\/|$)/.test(p))).toEqual([]);
    });
});

describe('with github auth configured', () => {
    it('answers /api/health with no credential at all', async () => {
        const server = await build(githubAuth(), memoryAuthStore());
        const response = await server.inject({ method: 'GET', url: '/api/health' });
        expect(response.statusCode).toBe(HTTP_OK);
    });

    it('answers /api/version with the packaged version and no credential at all', async () => {
        const server = await build(githubAuth(), memoryAuthStore());
        const response = await server.inject({ method: 'GET', url: '/api/version' });
        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json()).toEqual({ version: readVersion() });
    });

    it('401s the dashboard for an anonymous caller', async () => {
        const server = await build(githubAuth(), memoryAuthStore());
        const response = await server.inject({ method: 'GET', url: '/api/stats?range=all' });
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
        expect(response.json().code).toBe('UNAUTHENTICATED');
    });

    it('401s POST /api/jobs, which is the whole reason this exists', async () => {
        const server = await build(githubAuth(), memoryAuthStore());
        const response = await server.inject({
            method: 'POST',
            url: '/api/jobs',
            payload: { command: 'rm -rf /' },
        });
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
    });

    it('lets a signed-in member queue a job', async () => {
        const store = memoryAuthStore();
        const server = await build(githubAuth(), store);
        const caller = store.seedMember(ORG, 'octocat');
        const cookie = await signedIn(store, caller);

        const response = await server.inject({
            method: 'POST',
            url: '/api/jobs',
            payload: { command: 'echo hi', repo: 'acme/web' },
            headers: { cookie },
        });

        expect(response.statusCode).toBe(HTTP_CREATED);
    });

    it('stops honouring a session the moment its membership is removed', async () => {
        const store = memoryAuthStore();
        const server = await build(githubAuth(), store);
        const caller = store.seedMember(ORG, 'octocat');
        const cookie = await signedIn(store, caller);
        expect((await server.inject({ method: 'GET', url: '/api/jobs', headers: { cookie } })).statusCode).toBe(
            HTTP_OK
        );

        // Nothing in production deletes a membership except the sign-in propagation (GitHub no
        // longer reporting an installation) — which is exactly what this stands in for.
        store.removeMembership(ORG, caller.user.id);

        // The next request, not the next fortnight. This immediacy is why sessions are rows.
        const response = await server.inject({ method: 'GET', url: '/api/jobs', headers: { cookie } });
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
    });

    it('refuses a forged cookie', async () => {
        const store = memoryAuthStore();
        const server = await build(githubAuth(), store);
        const response = await server.inject({
            method: 'GET',
            url: '/api/jobs',
            headers: { cookie: `${SESSION_COOKIE}=made-up.signature` },
        });
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
    });
});

describe('the two credentials are disjoint: claim and job-scoped routes', () => {
    it('refuses a session cookie on the claim route spelled with percent-encoding', async () => {
        const store = memoryAuthStore();
        const server = await build(githubAuth(), store);
        const caller = store.seedMember(ORG, 'octocat', 'admin');
        const cookie = await signedIn(store, caller);
        for (const url of ['/api/jobs/cl%61im', '/api/%6Aobs/claim', '/api/jobs/%63laim']) {
            const response = await server.inject({
                method: 'POST',
                url,
                payload: { worker: 'w', leaseSeconds: 60 },
                headers: { cookie },
            });
            expect(response.statusCode, url).toBe(HTTP_UNAUTHORIZED);
        }
    });

    it('refuses a session cookie on the claim route', async () => {
        const store = memoryAuthStore();
        const server = await build(githubAuth(), store);
        const caller = store.seedMember(ORG, 'octocat', 'admin');
        const cookie = await signedIn(store, caller);

        const response = await server.inject({
            method: 'POST',
            url: '/api/jobs/claim',
            payload: { worker: 'driver-1' },
            headers: { cookie },
        });

        // Even an admin. A member holding a lease is a member able to take work away from the
        // driver that is running it.
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
    });

    it('accepts the shared board secret on the claim route', async () => {
        const store = memoryAuthStore();
        const server = await build(githubAuth(), store);

        const response = await server.inject({
            method: 'POST',
            url: '/api/jobs/claim',
            payload: { worker: 'driver-1' },
            headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        });

        // No org binding and no token row: the secret IS the driver credential, and the claim is
        // offered every org's queue.
        expect(response.statusCode).toBe(HTTP_OK);
    });

    const ASK = {
        leaseToken: LEASE,
        questionId: 'toolu_01',
        questions: [
            {
                question: 'Which?',
                header: 'Pick',
                multiSelect: false,
                options: [{ label: 'A' }, { label: 'B' }],
            },
        ],
    };

    // The worker token reaches the question report route the driver owns; the answer is a
    // person's, so the same credential is refused on it.
    it('accepts the shared board secret on the question report only', async () => {
        const server = await build(githubAuth(), memoryAuthStore());
        const worker = { authorization: `Bearer ${WORKER_TOKEN}` };

        const ask = await server.inject({
            method: 'POST',
            url: `/api/jobs/${JOB_ID}/question`,
            payload: ASK,
            headers: worker,
        });
        const answer = await server.inject({
            method: 'POST',
            url: `/api/jobs/${JOB_ID}/questions/toolu_01/answer`,
            payload: { answers: { 'Which?': 'A' } },
            headers: worker,
        });

        // The stub's lease verdicts are irrelevant: what matters is the credential got through.
        expect(ask.statusCode).not.toBe(HTTP_UNAUTHORIZED);
        expect(answer.statusCode).toBe(HTTP_UNAUTHORIZED);
    });

    it('refuses a session cookie on the question report', async () => {
        const store = memoryAuthStore();
        const server = await build(githubAuth(), store);
        const cookie = await signedIn(store, store.seedMember(ORG, 'octocat', 'admin'));

        const response = await server.inject({
            method: 'POST',
            url: `/api/jobs/${JOB_ID}/question`,
            payload: ASK,
            headers: { cookie },
        });

        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
    });

    it('lets a signed-in member answer, and refuses an organization token', async () => {
        const store = memoryAuthStore();
        const server = await build(githubAuth(), store);
        const cookie = await signedIn(store, store.seedMember(ORG, 'octocat'));
        const url = `/api/jobs/${JOB_ID}/questions/toolu_01/answer`;
        const payload = { answers: { 'Which?': 'A' } };

        const member = await server.inject({ method: 'POST', url, payload, headers: { cookie } });
        const orgToken = await server.inject({
            method: 'POST',
            url,
            payload,
            headers: { authorization: `Bearer ${store.seedAccessToken(ORG, 'org')}` },
        });

        // The stub answers a closed question: reaching the handler is the assertion.
        expect(member.statusCode).toBe(HTTP_CONFLICT);
        expect(orgToken.statusCode).toBe(HTTP_FORBIDDEN);
    });

    it("404s a member of another org on the first org's question", async () => {
        const otherOrg = 'other-org';
        const store = memoryAuthStore();
        const config = testConfig({ auth: githubAuth() });
        const board = (jobs: JobStore) => staticRegistry({ config, jobs, telemetry: stubTelemetryClient() });
        // Each org's store only knows its own rows: the other org's holds no such question.
        const boards = new Map([
            [ORG, board(jobStub())],
            [otherOrg, board(jobStub({ answerQuestion: async () => ({ result: 'unknown' }) }))],
        ]);
        const app = await buildApp({
            config,
            orgs: {
                for: async (orgId) => {
                    const runtime = await boards.get(orgId)?.for(orgId);
                    return runtime ? { ...runtime, orgId } : null;
                },
                list: async () => [...boards.keys()].map((id) => ({ id, name: id, installationId: null })),
                warmAll: async () => {},
                reconcileBatches: async () => {},
                observeBatchPrs: async () => {},
            },
            store: telemetryStoreStub(),
            auth: store,
        });
        track(app);
        const cookie = await signedIn(store, store.seedMember(otherOrg, 'mallory'));

        const response = await app.inject({
            method: 'POST',
            url: `/api/jobs/${JOB_ID}/questions/toolu_01/answer`,
            payload: { answers: { 'Which?': 'A' } },
            headers: { cookie },
        });

        expect(response.statusCode).toBe(HTTP_NOT_FOUND);
    });

    it('resolves a job-scoped worker call from the row its URL names', async () => {
        const store = memoryAuthStore();
        const server = await build(githubAuth(), store);

        const response = await server.inject({
            method: 'POST',
            url: `/api/jobs/${JOB_ID}/heartbeat`,
            payload: { leaseToken: LEASE },
            headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        });

        expect(response.statusCode).toBe(HTTP_OK);
    });

    it('404s a job-scoped worker call whose job does not exist', async () => {
        const store = memoryAuthStore();
        const server = await build(githubAuth(), store);

        const response = await server.inject({
            method: 'POST',
            url: '/api/jobs/99999999-9999-4999-8999-999999999999/heartbeat',
            payload: { leaseToken: LEASE },
            headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        });

        // Authenticated (the secret matched) but routed nowhere: the org read from the row is
        // the only honest answer, and there is no row.
        expect(response.statusCode).toBe(HTTP_NOT_FOUND);
    });

    it('404s a job-scoped worker call whose id is not a uuid', async () => {
        const store = memoryAuthStore();
        const server = await build(githubAuth(), store, undefined, [ORG]);

        const response = await server.inject({
            method: 'POST',
            url: '/api/jobs/not-a-uuid/heartbeat',
            payload: { leaseToken: LEASE },
            headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        });

        // A malformed id names no row either. Letting it through with a null org hands the
        // route's storeOf() an org that does not exist, and the driver reads a 503
        // JOBS_UNAVAILABLE where the route's own id validation should have spoken.
        expect(response.statusCode).toBe(HTTP_NOT_FOUND);
    });

    it('404s a reclaim ack whose id is not a uuid', async () => {
        const store = memoryAuthStore();
        const server = await build(githubAuth(), store, undefined, [ORG]);

        const response = await server.inject({
            method: 'POST',
            url: '/api/reclaims/not-a-uuid/ack',
            payload: { worker: 'driver-1' },
            headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        });

        expect(response.statusCode).toBe(HTTP_NOT_FOUND);
    });
});

describe('the two credentials are disjoint: cross-credential refusals', () => {
    it('refuses the worker secret on a human route', async () => {
        const store = memoryAuthStore();
        const server = await build(githubAuth(), store);

        const response = await server.inject({
            method: 'POST',
            url: '/api/jobs',
            payload: { command: 'echo hi' },
            headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        });

        // A job queued by the driver would have no author, silently breaking the audit trail.
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
    });

    it('keeps the thread read session-only, in both directions', async () => {
        // The SPA renders the task detail page with a session cookie — that has to keep working.
        const sessionStore = memoryAuthStore();
        const sessionServer = await build(githubAuth(), sessionStore);
        const caller = sessionStore.seedMember(ORG, 'octocat');
        const cookie = await signedIn(sessionStore, caller);
        expect(
            (
                await sessionServer.inject({
                    method: 'GET',
                    url: `/api/jobs/${JOB_ID}/thread`,
                    headers: { cookie },
                })
            ).statusCode
        ).toBe(HTTP_OK);

        // The worker secret on the full thread read would let the driver read commands, output
        // and session ids of jobs it never held a lease on — the thread is audit data, and the
        // driver's only need from it (the reclaim terminality) rides the complete response.
        const tokenServer = await build(githubAuth(), memoryAuthStore());
        expect(
            (
                await tokenServer.inject({
                    method: 'GET',
                    url: `/api/jobs/${JOB_ID}/thread`,
                    headers: { authorization: `Bearer ${WORKER_TOKEN}` },
                })
            ).statusCode
        ).toBe(HTTP_UNAUTHORIZED);
    });

    it("refuses the worker secret on the single-job read, which stays a person's", async () => {
        const store = memoryAuthStore();
        const server = await build(githubAuth(), store);

        const response = await server.inject({
            method: 'GET',
            url: `/api/jobs/${JOB_ID}`,
            headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        });

        // The job row — command, output, verdict — is a person's view of their audit trail; a
        // worker secret reaching it would make a member's session no stronger than any leaked one.
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
    });

    it('refuses a wrong secret', async () => {
        const store = memoryAuthStore();
        const server = await build(githubAuth(), store);

        const response = await server.inject({
            method: 'POST',
            url: '/api/jobs/claim',
            payload: { worker: 'driver-1' },
            headers: { authorization: 'Bearer fwt_a-token-from-another-deployment' },
        });

        // There is no row to be revoked: the secret simply matches or it does not. A deployment
        // rotates by changing the value on both sides.
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
    });
});

describe('the batch routes are a person’s', () => {
    it('has a row for every route the batch routes register', async () => {
        const batches = Fastify();
        const registered = new Set<string>();
        batches.addHook('onRoute', (route) => {
            // Fastify auto-registers HEAD beside each GET; the table lists the routes themselves.
            if (route.method === 'HEAD') return;
            registered.add(`${route.method} ${route.url.replace(':id', JOB_ID).replace(':key', 'a')}`);
        });
        await batches.register(batchRoutes({ orgs: {} as OrgRegistry }));
        await batches.ready();
        await batches.close();

        const tabled = BATCH_PATHS.map(([method, path]) => `${method} ${path}`);
        expect([...registered].sort()).toEqual([...tabled].sort());
    });

    it.each(BATCH_PATHS)('%s %s refuses the worker token', async (method, url) => {
        const server = await build(githubAuth(), memoryAuthStore());
        const response = await server.inject({
            method: method as 'GET',
            url,
            ...(method === 'GET' ? {} : { payload: {} }),
            headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        });
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
    });

    it.each(BATCH_PATHS)('%s %s refuses an organization token with 403', async (method, url) => {
        const store = memoryAuthStore();
        const server = await build(githubAuth(), store);
        const response = await server.inject({
            method: method as 'GET',
            url,
            ...(method === 'GET' ? {} : { payload: {} }),
            headers: { authorization: `Bearer ${store.seedAccessToken(ORG, 'org')}` },
        });
        expect(response.statusCode).toBe(HTTP_FORBIDDEN);
        expect(response.json().code).toBe('FORBIDDEN');
    });

    it.each(BATCH_PATHS)('%s %s refuses a request with no credential', async (method, url) => {
        const server = await build(githubAuth(), memoryAuthStore());
        const response = await server.inject({
            method: method as 'GET',
            url,
            ...(method === 'GET' ? {} : { payload: {} }),
        });
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
    });

    it('lets a signed-in member through the wall', async () => {
        const store = memoryAuthStore();
        const server = await build(githubAuth(), store);
        const cookie = await signedIn(store, store.seedMember(ORG, 'octocat'));
        const response = await server.inject({ method: 'GET', url: '/api/batches', headers: { cookie } });
        // No batch store behind this registry, so the route's own 503: it got past the hook.
        expect(response.statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
    });
});

describe('the person routes need a session', () => {
    it.each(PERSON_ROUTES)('%s %s refuses a request with no credential', async (method, url) => {
        const server = await build(githubAuth(), memoryAuthStore());
        const response = await server.inject({
            method: method as 'GET',
            url,
            ...(method === 'GET' || method === 'DELETE' ? {} : { payload: {} }),
        });
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
        expect(response.json().code).toBe('UNAUTHENTICATED');
    });

    it.each(PERSON_ROUTES)('%s %s refuses the worker token', async (method, url) => {
        const server = await build(githubAuth(), memoryAuthStore());
        const response = await server.inject({
            method: method as 'GET',
            url,
            ...(method === 'GET' || method === 'DELETE' ? {} : { payload: {} }),
            headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        });
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
        expect(response.json().code).toBe('UNAUTHENTICATED');
    });
});

describe('telemetry ingest', () => {
    it('stays open when no ingest token is configured', async () => {
        // Unset must keep behaving exactly as it did before accounts existed, or every collector
        // and every developer laptop breaks on upgrade with no migration path.
        const server = await build(githubAuth(), memoryAuthStore());
        const response = await server.inject({
            method: 'POST',
            url: '/api/otlp/v1/logs',
            payload: { resourceLogs: [] },
        });
        expect(response.statusCode).not.toBe(HTTP_UNAUTHORIZED);
    });

    it('requires the header once a token is configured', async () => {
        const server = await build(githubAuth({ ingestToken: 'ingest-secret' }), memoryAuthStore());

        const without = await server.inject({
            method: 'POST',
            url: '/api/otlp/v1/logs',
            payload: { resourceLogs: [] },
        });
        expect(without.statusCode).toBe(HTTP_UNAUTHORIZED);

        const with_ = await server.inject({
            method: 'POST',
            url: '/api/otlp/v1/logs',
            payload: { resourceLogs: [] },
            headers: { 'x-factory-ingest-token': 'ingest-secret' },
        });
        expect(with_.statusCode).not.toBe(HTTP_UNAUTHORIZED);

        // The OTLP routes are the ONLY thing the ingest token still reaches. It is a deployment
        // -wide authenticity check for machine exports, never an org binding — which is exactly
        // why it must not authorize a branch write (see the branch describe below).
        const branch = await server.inject({
            method: 'POST',
            url: '/api/sessions/branch',
            payload: { agent: 'claude', sessionId: 'abc', repo: 'a/b', branch: 'dev' },
            headers: { 'x-factory-ingest-token': 'ingest-secret' },
        });
        expect(branch.statusCode).toBe(HTTP_UNAUTHORIZED);
    });
});

describe('the branch route needs an org-bound credential in github mode', () => {
    const report = { agent: 'claude', sessionId: 'abc', repo: 'a/b', branch: 'dev', at: '2026-08-21T10:40:00Z' };

    // The runner's reporter presents the attempt it runs for — the job it claimed and that
    // attempt's lease token — and the server's verifier answers the org the pair belongs to.
    // A failed pair is a 401 with no fall-through: a caller presenting a credential that does
    // not resolve must not be able to ride a weaker one standing behind it, the same rule a
    // failed bearer gets on the person routes.
    it('resolves the org from the attempt’s job id + lease token pair', async () => {
        const server = await build(githubAuth(), memoryAuthStore());
        const response = await server.inject({
            method: 'POST',
            url: '/api/sessions/branch',
            payload: report,
            headers: { 'x-factory-job-id': JOB_ID, 'x-factory-job-lease-token': LEASE },
        });
        expect(response.statusCode).toBe(HTTP_ACCEPTED);
    });

    it('401s a pair that does not resolve, even with a bearer behind it', async () => {
        const store = memoryAuthStore();
        const server = await build(githubAuth(), store);
        const caller = store.seedMember(ORG, 'octocat');
        const token = store.seedAccessToken(ORG, 'personal', { userId: caller.user.id });
        const response = await server.inject({
            method: 'POST',
            url: '/api/sessions/branch',
            payload: report,
            headers: {
                'x-factory-job-id': JOB_ID,
                'x-factory-job-lease-token': '99999999-9999-4999-8999-999999999999',
                authorization: `Bearer ${token}`,
            },
        });
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
        expect(response.json().code).toBe('UNAUTHENTICATED');
    });

    it('401s a missing pair', async () => {
        const server = await build(githubAuth(), memoryAuthStore());
        const response = await server.inject({ method: 'POST', url: '/api/sessions/branch', payload: report });
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
    });

    it('accepts a personal access token — the laptop plugin’s credential', async () => {
        const store = memoryAuthStore();
        const server = await build(githubAuth(), store);
        const caller = store.seedMember(ORG, 'octocat');
        const token = store.seedAccessToken(ORG, 'personal', { userId: caller.user.id });
        const response = await server.inject({
            method: 'POST',
            url: '/api/sessions/branch',
            payload: report,
            headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode).toBe(HTTP_ACCEPTED);
    });

    // 403, not 401, and deliberately so: the oat_ DID authenticate — findOrgToken resolved it —
    // and the refusal is the route needing a human-or-lease credential behind it, the exact
    // shape orgTokenAllowed already answers with on the person routes. org tokens are a
    // read-only allowlist; branch ingest is a write.
    it('403s an organization token — the read-only allowlist must not reach a write', async () => {
        const store = memoryAuthStore();
        const server = await build(githubAuth(), store);
        const token = store.seedAccessToken(ORG, 'org');
        const response = await server.inject({
            method: 'POST',
            url: '/api/sessions/branch',
            payload: report,
            headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode).toBe(HTTP_FORBIDDEN);
        expect(response.json().code).toBe('FORBIDDEN');
    });

    it('stays open in none mode, like every other route in it', async () => {
        const store = memoryAuthStore();
        store.seedLocalUser('default');
        const server = await build({ mode: 'none', ingestToken: null }, store, async () => {
            throw new Error('none mode must not consult the lease');
        });
        const response = await server.inject({ method: 'POST', url: '/api/sessions/branch', payload: report });
        expect(response.statusCode).toBe(HTTP_ACCEPTED);
    });
});

describe('AUTH_MODE=none', () => {
    it('runs the auth path and attributes requests to the stand-in account', async () => {
        /*
         * The mode still resolves a caller rather than skipping the hook. That is what keeps one
         * code path downstream — and what keeps created_by populated in the environment where the
         * feature is actually developed.
         */
        const store = memoryAuthStore();
        store.seedLocalUser('default');
        const server = await build({ mode: 'none', ingestToken: null }, store);

        const response = await server.inject({
            method: 'POST',
            url: '/api/jobs',
            payload: { command: 'echo hi', repo: 'acme/web' },
        });

        expect(response.statusCode).toBe(HTTP_CREATED);
    });

    it('lets a driver claim with no token, because `none` means no credentials at all', async () => {
        /*
         * The two credentials are disjoint when there ARE credentials. Requiring a worker token
         * here would buy nothing — anyone who can reach this port can already queue a command an
         * agent runs — while breaking `npm run driver` against a local board and scripts/
         * test-jobs.sh, which drives the whole lease protocol with no credential at all.
         */
        const store = memoryAuthStore();
        store.seedLocalUser('default');
        const server = await build({ mode: 'none', ingestToken: null }, store);

        const response = await server.inject({
            method: 'POST',
            url: '/api/jobs/claim',
            payload: { worker: 'driver-1' },
        });

        expect(response.statusCode).toBe(HTTP_OK);
    });

    it('reports the stand-in account from /api/auth/me, with nothing pretending to be GitHub data', async () => {
        /*
         * The settings page renders this caller. Its login is unrepresentable as a real GitHub
         * login and its numeric id is 0, a value GitHub never issues — so the payload must carry
         * the facts as they are and let the page decide what a stand-in looks like, rather than
         * the server inventing a displayable identity.
         */
        const store = memoryAuthStore();
        store.seedLocalUser('default');
        const server = await build({ mode: 'none', ingestToken: null }, store);

        const response = await server.inject({ method: 'GET', url: '/api/auth/me' });

        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json()).toMatchObject({
            user: { login: '__local__', githubUserId: 0, avatarUrl: null },
            role: 'admin',
            mode: 'none',
        });
        // The API server keeps no member directory, so there is no path to report.
        expect(response.json()).not.toHaveProperty('workspacePath');
    });
});
