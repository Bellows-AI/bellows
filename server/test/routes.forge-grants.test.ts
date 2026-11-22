import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import {
    githubAuth,
    memberGrantsFake,
    memoryAuthStore,
    signedIn,
    staticRegistry,
    stubTelemetryClient,
    testConfig,
} from './helpers.js';
import { HTTP_OK, HTTP_UNAUTHORIZED, trackApps } from './helpers-http.js';

/**
 * `GET /api/forge-grants` (BEL-528): where the member stands on each forge, for the Settings card. The standing is the
 * grant store's; an unconfirmed read is a 503, never a "not connected" that would send the member to re-authorize.
 */

const track = trackApps();
const ORG = '424242';
const HTTP_UNAVAILABLE = 503;

async function boot(withGrants = true) {
    const auth = memoryAuthStore();
    const member = auth.seedMember(ORG, 'octocat');
    const memberGrants = memberGrantsFake();
    const config = testConfig({ auth: githubAuth() });
    const app = await buildApp({
        config,
        orgs: staticRegistry({ config, telemetry: stubTelemetryClient() }),
        auth,
        ...(withGrants ? { memberGrants } : {}),
    });
    track(app);
    const cookies = { cookie: await signedIn(auth, member) };
    const read = (headers: Record<string, string> = cookies) =>
        app.inject({ method: 'GET', url: '/api/forge-grants', headers });
    return { read, memberGrants, member };
}

describe('GET /api/forge-grants', () => {
    it('needs a session', async () => {
        const { read } = await boot();
        expect((await read({})).statusCode).toBe(HTTP_UNAUTHORIZED);
    });

    it.each(['live', 'broken', 'missing'] as const)(
        'reports a %s GitHub grant with the login and the connect path',
        async (standing) => {
            const { read, memberGrants } = await boot();
            memberGrants.standingAnswer = standing;

            const response = await read();

            expect(response.statusCode).toBe(HTTP_OK);
            const { grants } = response.json() as {
                grants: { forge: string; login: string; standing: string; connectPath: string }[];
            };
            expect(grants).toHaveLength(1);
            expect(grants[0]).toMatchObject({ forge: 'github', login: 'octocat', standing });
            const connect = new URL(grants[0]!.connectPath, 'http://board.test');
            expect(connect.pathname).toBe('/api/auth/github');
            expect(connect.searchParams.get('returnTo')).toBe('/settings/integrations');
            expect(connect.searchParams.get('org')).toBe(ORG);
        }
    );

    it('reports no grants where the board keeps none', async () => {
        const { read } = await boot(false);
        const response = await read();
        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json()).toEqual({ grants: [] });
    });

    it('is a 503, never "missing", when the standing could not be read', async () => {
        const { read, memberGrants } = await boot();
        memberGrants.standing = async () => {
            throw new Error('database unreachable');
        };

        const response = await read();

        expect(response.statusCode).toBe(HTTP_UNAVAILABLE);
        expect(JSON.stringify(response.json())).not.toContain('missing');
        expect(JSON.stringify(response.json())).not.toContain('unreachable');
    });
});
