import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { GithubAttempt, GithubCredentialOfLease } from '../src/db/github-credential.js';
import type { InstallationTokenProvider, MintedToken } from '../src/github/app-token.js';
import { githubAuth, memoryAuthStore, staticRegistry, stubTelemetryClient, testConfig } from './helpers.js';
import {
    HTTP_BAD_GATEWAY,
    HTTP_CONFLICT,
    HTTP_FORBIDDEN,
    HTTP_OK,
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
const LIVE: GithubAttempt = { ok: true, orgId: 'local', repo: 'acme/widgets' };

const track = trackApps();

interface Boot {
    /** The check's answers in call order; the last one repeats. */
    answers?: GithubAttempt[];
    /** The org's installation; absent is the offline board. */
    fresh?: (repo?: string | null) => Promise<MintedToken>;
    mode?: 'github' | 'none';
}

async function boot({ answers = [LIVE], fresh, mode = 'github' }: Boot = {}) {
    const lines: string[] = [];
    const mints: (string | null | undefined)[] = [];
    let call = 0;
    const githubCredentialOfLease: GithubCredentialOfLease = async (jobId, leaseToken) => {
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
        githubCredentialOfLease,
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
