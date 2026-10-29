import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AttemptCheck, AttemptOfLease } from '../src/db/attempt-of-lease.js';
import type { InstallationTokenProvider, MintedToken } from '../src/github/app-token.js';
import { githubAuth, memoryAuthStore, staticRegistry, stubTelemetryClient, testConfig } from './helpers.js';
import {
    HTTP_BAD_GATEWAY,
    HTTP_CONFLICT,
    HTTP_FORBIDDEN,
    HTTP_OK,
    HTTP_SERVICE_UNAVAILABLE,
    HTTP_UNAUTHORIZED,
    trackApps,
} from './helpers-http.js';
import { TEST_JOB_BOARD_TOKEN } from './helpers-config.js';

/**
 * Offline: the runner GitHub credential route's HTTP contract (docs/connections.md) against a stub
 * per-call check and a stub installation. The check's own SQL — lease rotation, cancel, membership,
 * reviewer rows — and a cancel landing during the exchange are pinned by
 * server/test-db/github-credential.test.ts.
 */

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const LEASE = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'ghs_route_test_secret_token_value';
const EXPIRES_AT = '2026-10-16T13:00:00.000Z';
const PAIR = { 'x-factory-job-id': JOB_ID, 'x-factory-job-lease-token': LEASE };
const URL_PATH = `/api/jobs/${JOB_ID}/credentials/github`;
const LIVE: AttemptCheck = {
    ok: true,
    orgId: 'local',
    jobId: JOB_ID,
    rootJobId: JOB_ID,
    repo: 'acme/widgets',
    rootRepo: 'acme/widgets',
    executionUserId: '66666666-6666-4666-8666-666666666666',
    claimSeq: 1,
};

const track = trackApps();

interface Boot {
    /** The check's answers in call order; the last one repeats. */
    answers?: AttemptCheck[];
    /** The org's installation; absent is the offline board. */
    fresh?: (repo?: string | null) => Promise<MintedToken>;
    mode?: 'github' | 'none';
    /** The check throws instead of answering. */
    throwing?: boolean;
}

async function boot({ answers = [LIVE], fresh, mode = 'github', throwing = false }: Boot = {}) {
    const lines: string[] = [];
    const mints: (string | null | undefined)[] = [];
    let call = 0;
    const attemptOfLease: AttemptOfLease = async (jobId, leaseToken) => {
        if (throwing) throw new Error('connection terminated');
        const answer = answers[Math.min(call, answers.length - 1)] ?? { ok: false };
        call += 1;
        return jobId === JOB_ID && leaseToken === LEASE ? answer : { ok: false };
    };
    const githubToken = fresh
        ? ({
              get: async () => 'unscoped',
              installationId: async () => '4242',
              fresh: async (repo?: string | null) => {
                  mints.push(repo);
                  return fresh(repo);
              },
          } satisfies InstallationTokenProvider)
        : undefined;
    const config = testConfig({ auth: mode === 'github' ? githubAuth() : testConfig().auth });
    const app = await buildApp({
        config,
        orgs: staticRegistry({ config, telemetry: stubTelemetryClient(), ...(githubToken ? { githubToken } : {}) }),
        auth: memoryAuthStore(),
        attemptOfLease,
        logger: { level: 'trace', stream: { write: (line: string) => lines.push(line) } },
    });
    track(app);
    return { app, lines, mints, checks: () => call };
}

const minted = async (): Promise<MintedToken> => ({ token: TOKEN, expiresAt: EXPIRES_AT });

describe('the runner GitHub credential route', () => {
    it("answers a live attempt with a token narrowed to its repo and GitHub's expiry, never cached", async () => {
        const { app, mints, checks } = await boot({ fresh: minted });
        const res = await app.inject({ method: 'POST', url: URL_PATH, headers: PAIR });
        expect(res.statusCode).toBe(HTTP_OK);
        expect(res.json()).toEqual({ token: TOKEN, expiresAt: EXPIRES_AT });
        expect(res.headers['cache-control']).toBe('no-store');
        expect(mints).toEqual(['acme/widgets']);
        // Checked before the mint and again after it.
        expect(checks()).toBe(2);
    });

    it('answers 409 GITHUB_UNAVAILABLE when the org holds no App installation', async () => {
        const { app } = await boot();
        const res = await app.inject({ method: 'POST', url: URL_PATH, headers: PAIR });
        expect(res.statusCode).toBe(HTTP_CONFLICT);
        expect(res.json().code).toBe('GITHUB_UNAVAILABLE');
        expect(res.headers['cache-control']).toBe('no-store');
    });

    it('refuses an attempt the check refuses, and mints nothing for it', async () => {
        const { app, mints } = await boot({ answers: [{ ok: false }], fresh: minted });
        const res = await app.inject({ method: 'POST', url: URL_PATH, headers: PAIR });
        expect(res.statusCode).toBe(HTTP_FORBIDDEN);
        expect(res.json().code).toBe('CONNECTION_NOT_AUTHORIZED');
        expect(mints).toEqual([]);
    });

    it('refuses a job id that is not a uuid without asking the check', async () => {
        const { app, checks } = await boot({ fresh: minted });
        const res = await app.inject({
            method: 'POST',
            url: '/api/jobs/not-a-uuid/credentials/github',
            headers: { ...PAIR, 'x-factory-job-id': 'not-a-uuid' },
        });
        expect(res.statusCode).toBe(HTTP_FORBIDDEN);
        expect(checks()).toBe(0);
    });

    // A command-only task has no repository to narrow to: its mint would be installation-wide.
    it('refuses an attempt with no repository before any mint', async () => {
        const { app, mints } = await boot({ answers: [{ ...LIVE, repo: null }], fresh: minted });
        const res = await app.inject({ method: 'POST', url: URL_PATH, headers: PAIR });
        expect(res.statusCode).toBe(HTTP_FORBIDDEN);
        expect(res.json().code).toBe('CONNECTION_NOT_AUTHORIZED');
        expect(res.json().error).toMatch(/no repository/);
        expect(mints).toEqual([]);
    });

    // The check no longer compares repositories (the broker does not need to); the token's narrowing does.
    it('refuses an attempt not working its thread root’s repository before any mint', async () => {
        const { app, mints } = await boot({ answers: [{ ...LIVE, rootRepo: 'acme/elsewhere' }], fresh: minted });
        const res = await app.inject({ method: 'POST', url: URL_PATH, headers: PAIR });
        expect(res.statusCode).toBe(HTTP_FORBIDDEN);
        expect(res.json().code).toBe('CONNECTION_NOT_AUTHORIZED');
        expect(mints).toEqual([]);
    });

    it('answers 503 retryable, not a refusal, when the check cannot be read', async () => {
        const { app, mints } = await boot({ answers: [], fresh: minted, throwing: true });
        const res = await app.inject({ method: 'POST', url: URL_PATH, headers: PAIR });
        expect(res.statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
        expect(res.json().code).toBe('UNAVAILABLE');
        expect(mints).toEqual([]);
    });

    it('refuses a lease token that is not a uuid without asking the check', async () => {
        const { app, checks } = await boot({ fresh: minted });
        const res = await app.inject({
            method: 'POST',
            url: URL_PATH,
            headers: { ...PAIR, 'x-factory-job-lease-token': 'not-a-uuid' },
        });
        expect(res.statusCode).toBe(HTTP_FORBIDDEN);
        expect(checks()).toBe(0);
    });

    it('withholds the token when the attempt ended during the exchange', async () => {
        const { app, lines } = await boot({ answers: [LIVE, { ok: false }], fresh: minted });
        const res = await app.inject({ method: 'POST', url: URL_PATH, headers: PAIR });
        expect(res.statusCode).toBe(HTTP_FORBIDDEN);
        expect(res.body).not.toContain(TOKEN);
        expect(lines.join('\n')).not.toContain(TOKEN);
    });

    it("answers 502 without GitHub's words when the mint fails, and logs no detail", async () => {
        const detail = `installation token request failed with 500: echoed ${TOKEN}`;
        const { app, lines } = await boot({
            fresh: async () => {
                throw new Error(detail);
            },
        });
        const res = await app.inject({ method: 'POST', url: URL_PATH, headers: PAIR });
        expect(res.statusCode).toBe(HTTP_BAD_GATEWAY);
        expect(res.json().code).toBe('UNAVAILABLE');
        expect(res.body).not.toContain(TOKEN);
        expect(lines.join('\n')).not.toContain(TOKEN);
    });

    it('keeps the token out of every log line of a successful answer', async () => {
        const { app, lines } = await boot({ fresh: minted });
        const res = await app.inject({ method: 'POST', url: URL_PATH, headers: PAIR });
        expect(res.statusCode).toBe(HTTP_OK);
        expect(lines.length).toBeGreaterThan(0);
        expect(lines.join('\n')).not.toContain(TOKEN);
    });

    it.each(['github', 'none'] as const)(
        'takes the attempt pair and nothing else, under AUTH_MODE=%s',
        async (mode) => {
            const { app, mints } = await boot({ fresh: minted, mode });
            const bare = await app.inject({ method: 'POST', url: URL_PATH });
            expect(bare.statusCode).toBe(HTTP_UNAUTHORIZED);
            const worker = await app.inject({
                method: 'POST',
                url: URL_PATH,
                headers: { authorization: `Bearer ${TEST_JOB_BOARD_TOKEN}` },
            });
            expect(worker.statusCode).toBe(HTTP_UNAUTHORIZED);
            // A pair naming another job than the URL is no pair for this one.
            const crossed = await app.inject({
                method: 'POST',
                url: `/api/jobs/33333333-3333-4333-8333-333333333333/credentials/github`,
                headers: PAIR,
            });
            expect(crossed.statusCode).toBe(HTTP_UNAUTHORIZED);
            expect(mints).toEqual([]);
        }
    );
});
