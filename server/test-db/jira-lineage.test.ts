import { createJiraIntegration, type FetchLike, JIRA_OPERATIONS, runOperation } from '@factory-ai/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createConnectionStore } from '../src/db/connection-store.js';
import { recoverIntegrations } from '../src/integrations/integration-recovery.js';
import { type FakeAtlassian, startFakeAtlassian } from '../test/fake-atlassian.js';
import { testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';
import { bindConnections, newRoot } from './integration-store-faults.js';
import { begin, connectionsOf, grantsOf, jiraRuntime, newTag, refreshCalls, resolveAs, script } from './jira-rig.js';

/**
 * BEL-61 slice 2: the refresh lineage with the real Jira hooks. Two runtimes over one database are two board
 * replicas; the scripted Atlassian counts every refresh it is asked for.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const ALICE = testUser('jira-lin-alice');
const db = useTestDb({ orgs: [ORG], users: [ALICE], max: 14 });

let fake: FakeAtlassian;
beforeEach(async () => {
    if (enabled) fake = await startFakeAtlassian();
});
afterEach(async () => {
    if (enabled) await fake.close();
});

/** Connects the account on replica A with a token already inside the refresh skew; binds one root per connection. */
async function expiring(tag: string, sites: string[] = ['one']) {
    const [a, b] = [jiraRuntime(db.sql, fake), jiraRuntime(db.sql, fake)];
    script(fake, { tag, sites, expiresIn: 1 });
    await (await begin(a, ORG, ALICE.id)).complete();
    const connections = await connectionsOf(db.sql, tag);
    const requests: { rootJobId: string; connectionId: string }[] = [];
    for (const connection of connections) {
        const rootJobId = await newRoot(db.sql, ORG, ALICE.id);
        await bindConnections(db.sql, { orgId: ORG, rootJobId, userId: ALICE.id }, [connection.id]);
        requests.push({ rootJobId, connectionId: connection.id });
    }
    return { a, b, requests };
}

const refreshAnswer = (fake: FakeAtlassian, reply: Parameters<FakeAtlassian['on']>[2]) =>
    fake.on('POST', /^\/oauth\/token$/, (call, n) =>
        (call.body as { grant_type?: string }).grant_type === 'refresh_token'
            ? reply(call, n)
            : { status: 200, json: { access_token: 'unused', expires_in: 1, scope: 'read:jira-work' } }
    );

describe.skipIf(!enabled)('jira lineage', () => {
    it('a concurrent resolve on two replicas of an expiring token refreshes once', async () => {
        const tag = newTag();
        const { a, b, requests } = await expiring(tag);
        const request = requests[0]!;
        const results = await Promise.all([resolveAs(a, ORG, ALICE.id, request), resolveAs(b, ORG, ALICE.id, request)]);
        expect(refreshCalls(fake)).toBe(1);
        expect(results.some((r) => r.ok)).toBe(true);
    });

    it('two connections of one grant refresh one lineage and resolve to the same new token', async () => {
        const tag = newTag();
        const { a, b, requests } = await expiring(tag, ['one', 'two']);
        const settled = await Promise.all([
            resolveAs(a, ORG, ALICE.id, requests[0]!),
            resolveAs(b, ORG, ALICE.id, requests[1]!),
        ]);
        const again = await Promise.all(settled.map((r, i) => (r.ok ? r : resolveAs(a, ORG, ALICE.id, requests[i]!))));
        const tokens = again.map((r) => (r.ok ? r.credential.accessToken : null));
        expect(tokens[0]).toBe(tokens[1]);
        // The scripted answer numbers every token call; the code exchange was the first.
        expect(tokens[0]).toBe(`${tag}-access-r2`);
        expect(refreshCalls(fake)).toBe(1);
    });

    it('a disconnect landing during the refresh exchange lets no token leave; the grant is revoked and the new secret destroyed', async () => {
        const tag = newTag();
        const { a, requests } = await expiring(tag);
        refreshAnswer(fake, () => ({
            status: 200,
            delayMs: 400,
            json: {
                access_token: `${tag}-late`,
                expires_in: 3600,
                refresh_token: `${tag}-refresh-late`,
                scope: 'read:jira-work',
            },
        }));
        const pending = resolveAs(a, ORG, ALICE.id, requests[0]!);
        while (refreshCalls(fake) === 0) await new Promise((r) => setTimeout(r, 10));
        const [connection] = await connectionsOf(db.sql, tag);
        const store = createConnectionStore({ sql: db.sql, orgId: ORG });
        expect((await store.disconnect(connection!.id, { userId: ALICE.id })).disconnected).toBe(true);

        const result = await pending;
        expect(result.ok).toBe(false);
        expect(JSON.stringify(result)).not.toContain(`${tag}-late`);
        const [grant] = await grantsOf(db.sql, tag);
        expect(grant!.status).toBe('revoked');
        await recoverIntegrations(a);
        expect((await grantsOf(db.sql, tag))[0]!.secret_version).toBeNull();
    });

    it('a refresh whose response is lost is reconnect_required, and the spent refresh token is never sent again', async () => {
        const tag = newTag();
        const { a, b, requests } = await expiring(tag);
        refreshAnswer(fake, () => ({ drop: true }));
        const first = await resolveAs(a, ORG, ALICE.id, requests[0]!);
        expect(first).toMatchObject({ ok: false, outcome: { outcome: 'integration_required', reason: 'reconnect' } });
        const second = await resolveAs(b, ORG, ALICE.id, requests[0]!);
        expect(second).toMatchObject({ ok: false, outcome: { outcome: 'integration_required', reason: 'reconnect' } });
        expect(refreshCalls(fake)).toBe(1);
        expect((await grantsOf(db.sql, tag))[0]!.status).toBe('reconnect_required');
    });

    it('invalid_grant on refresh is reconnect at the broker; a 403 from Jira on an operation stays provider-denied and the grant active', async () => {
        const tag = newTag();
        const { a, requests } = await expiring(tag);
        refreshAnswer(fake, () => ({ status: 403, json: { error: 'invalid_grant' } }));
        expect(await resolveAs(a, ORG, ALICE.id, requests[0]!)).toMatchObject({
            ok: false,
            outcome: { outcome: 'integration_required', reason: 'reconnect' },
        });

        const healthy = newTag();
        script(fake, { tag: healthy });
        const runtime = jiraRuntime(db.sql, fake);
        await (await begin(runtime, ORG, ALICE.id)).complete();
        const [connection] = await connectionsOf(db.sql, healthy);
        const rootJobId = await newRoot(db.sql, ORG, ALICE.id);
        await bindConnections(db.sql, { orgId: ORG, rootJobId, userId: ALICE.id }, [connection!.id]);
        const resolved = await resolveAs(runtime, ORG, ALICE.id, { rootJobId, connectionId: connection!.id });
        if (!resolved.ok) throw new Error('resolve refused');
        fake.on('GET', /\/rest\/api\/3\/issue\/ABC-1$/, () => ({ status: 403, json: { message: 'no' } }));
        const result = await runOperation(
            createJiraIntegration({ apiOrigin: fake.origin }),
            JIRA_OPERATIONS.getIssue,
            {
                handle: {
                    connectionId: connection!.id,
                    provider: 'jira',
                    resource: { id: connection!.cloud_id, label: connection!.site },
                    authority: resolved.credential.authority,
                },
                credentials: { acquire: async () => ({ ok: true, credential: resolved.credential }) },
                fetch: fetch as unknown as FetchLike,
                deadlineMs: 5000,
            },
            { key: 'ABC-1' }
        );
        expect(result).toEqual({ ok: false, outcome: { outcome: 'forbidden', reason: 'provider-denied' } });
        expect((await grantsOf(db.sql, healthy))[0]!.status).toBe('active');
    });
});
