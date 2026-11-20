import { logs } from '@opentelemetry/api';
import { afterAll, describe, expect, it } from 'vitest';
import { staticRepoSource } from '../src/github/repo-source.js';
import { buildWithAuth, githubAuth, memoryAuthStore, stubIdentityClient } from './helpers.js';
import { captureLogs } from './helpers-log.js';
import { trackApps } from './helpers-http.js';

const track = trackApps();
const SECRETS = ['tok_x', 'ck_x', 'code_x', 'st_x', 'o-x', 'n-x'];
const BRANCHES = '/api/repos/:owner/:name/branches';

async function logged() {
    const capture = captureLogs();
    const app = track(
        await buildWithAuth(
            githubAuth(),
            memoryAuthStore(),
            { repos: staticRepoSource([{ owner: 'o-x', name: 'n-x' }]) },
            { loggerInstance: capture.logger, identity: stubIdentityClient() }
        )
    );
    return { app, capture };
}

describe('request logs', () => {
    afterAll(() => logs.disable());

    it('carry no credential, OAuth query or repo name, on stdout or over OTLP', async () => {
        const { app, capture } = await logged();
        await app.inject({
            method: 'GET',
            url: '/api/jobs',
            headers: { authorization: 'Bearer tok_x', cookie: 's=ck_x' },
        });
        await app.inject({ method: 'GET', url: '/api/auth/github/callback?code=code_x&state=st_x' });
        await app.inject({ method: 'GET', url: '/api/repos/o-x/n-x/branches?t=tok_x' });
        await app.inject({ method: 'GET', url: '/api/no-such-route/o-x?code=code_x' });

        expect(capture.records().length).toBeGreaterThan(0);
        const all = capture.everything();
        for (const secret of SECRETS) expect(all).not.toContain(secret);
        capture.stop();
    });

    it('name the route pattern, or <unmatched>', async () => {
        const { app, capture } = await logged();
        await app.inject({ method: 'GET', url: '/api/repos/o-x/n-x/branches' });
        await app.inject({ method: 'GET', url: '/api/no-such-route' });
        const urls = capture
            .records()
            .map((r) => (r.req as { url?: string } | undefined)?.url)
            .filter(Boolean);
        expect(urls).toContain(BRANCHES);
        expect(urls).toContain('<unmatched>');
        capture.stop();
    });

    it('redact credential fields a handler logs', () => {
        const capture = captureLogs();
        capture.logger.info(
            { req: { headers: { authorization: 'Bearer tok_x', cookie: 's=ck_x' } }, grant: { token: 'tok_x' } },
            'm'
        );
        expect(capture.everything()).not.toContain('tok_x');
        expect(capture.everything()).not.toContain('ck_x');
        capture.stop();
    });
});
