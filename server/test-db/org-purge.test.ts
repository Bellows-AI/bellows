import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeploymentMode } from '@factory-ai/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { createFilesystemStore } from '../src/artifacts/fs-store.js';
import { chunkKey } from '../src/artifacts/keys.js';
import type { ObjectStore } from '../src/artifacts/object-store.js';
import { attachmentKey } from '../src/attachments/attachment-store.js';
import { createAuthStore } from '../src/auth/store.js';
import { grantSecretIdentity } from '../src/db/connection-grants.js';
import { ORG_TABLES } from '../src/db/org-tables.js';
import { type OrgPurgeDeps, runOrgPurgePass } from '../src/db/org-purge.js';
import { skillObjectKey } from '../src/db/skill-store.js';
import { createSecretStoreOver, type CoordinatedSecretStore } from '../src/secrets/postgres-secret-store.js';
import { createSecretRepo } from '../src/secrets/postgres-secret-repo.js';
import { createSecretRef } from '../src/secrets/secret-input.js';
import { type PayloadStore, ProviderFault } from '../src/secrets/secret-payloads.js';
import type { SecretIdentity, SecretRef } from '../src/secrets/secret-store.js';
import { craftJob, testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';
import { MutableKeys } from './secrets-postgres-harness.js';

/**
 * Deleting an organization (docs/organizations.md): the purge removes every secret the org owns — found by the
 * owner its identity names, so a secret no consumer row points at yet is found too — waits until the collector has
 * physically removed every version, removes the objects under the org's three key prefixes, then deletes the org
 * row, which cascades through every registered org table. A step that cannot be confirmed leaves the purge pending
 * and retried; it is never reported done. Only a suspended or refused org is purged, on the operator's request or,
 * in cloud mode, once GitHub's deletion deadline has passed.
 */
const org = testOrg();
const other = testOrg();
const user = testUser('org-purge');
const db = useTestDb({ orgs: [org, other], users: [user] });
const enabled = Boolean(db.url);

const PREFIX = 'factory/';
const ACCOUNT_LABEL = 'acct-confidential-name';
const STREAM = {
    member: 'member-1',
    root: 'root-1',
    job: 'job-1',
    claimSeq: 1,
    executor: 'claude-code',
    session: 'session-1',
    stream: 'raw',
};
const bytes = (text: string) => new TextEncoder().encode(text);

/**
 * A fake external secret provider: the payload outlives its row (two-phase removal), so a removal the provider
 * refuses leaves the version `deleting` until a later collector pass. `failWrite` lands the object and loses the
 * answer, the way an interrupted create leaves an unresolved operation and a staged version.
 */
class FakeProvider implements PayloadStore {
    readonly storage = 'aws' as const;
    readonly twoPhase = true;
    readonly objects = new Map<string, Uint8Array>();
    failRemove = false;
    failWrite = false;

    private mac(aad: { identityKey: string; ref: string; logicalVersion: string }, payload: Uint8Array): string {
        return createHash('sha256')
            .update(`${aad.identityKey}|${aad.ref}|${aad.logicalVersion}|`)
            .update(payload)
            .digest('hex');
    }
    prepare(aad: { identityKey: string; ref: string; logicalVersion: string }, versionId: string, payload: Uint8Array) {
        return {
            storage: this.storage,
            keyId: null,
            envelope: null,
            providerRef: `fake/${versionId}`,
            providerVersion: null,
            payloadMac: this.mac(aad, payload),
        };
    }
    holds(row: { payloadMac: string | null }, aad: Parameters<FakeProvider['mac']>[0], payload: Uint8Array) {
        return row.payloadMac === this.mac(aad, payload);
    }
    async write(row: { providerRef: string | null }, payload: Uint8Array) {
        const key = row.providerRef as string;
        const existed = this.objects.has(key);
        this.objects.set(key, payload);
        if (this.failWrite) throw new ProviderFault('ambiguous');
        return existed ? ('exists' as const) : ('written' as const);
    }
    async read(row: { providerRef: string | null }) {
        return this.objects.get(row.providerRef as string) ?? 'absent';
    }
    async remove(row: { providerRef: string | null }) {
        if (this.failRemove) throw new ProviderFault('retry');
        this.objects.delete(row.providerRef as string);
    }
}

const orgSecret = (orgId: string, name: string): SecretIdentity => ({
    owner: { kind: 'organization', orgId },
    scope: { type: 'organization', id: orgId },
    purpose: 'environment-secret',
    owningRecord: { type: 'env-var', id: name },
});

let provider: FakeProvider;
let store: CoordinatedSecretStore;
let objects: ObjectStore;
let lines: string[];

const deps = (over: Partial<OrgPurgeDeps> = {}): OrgPurgeDeps => ({
    sql: db.sql,
    secrets: store,
    objects,
    prefix: PREFIX,
    deploymentMode: 'cloud',
    log: (line) => lines.push(line),
    // No writer is in flight here; the drain itself is pinned by org-purge.fence.test.ts.
    writeDrainMs: 0,
    ...over,
});

async function create(identity: SecretIdentity, value: string): Promise<{ ref: SecretRef; version: string }> {
    const ref = createSecretRef();
    const made = await store.create({
        identity,
        ref,
        operationId: await store.issueOperationId(),
        payload: bytes(value),
    });
    if (!made.ok) throw new Error(`seed create failed: ${made.error.reason}`);
    return { ref, version: made.version };
}

/** Every key the org could hold, one per prefix: artifacts, attachments and skills. */
const keysOf = (orgId: string) => [
    `${PREFIX}${orgId}/`,
    `${PREFIX}_attachments/${orgId}/`,
    `${PREFIX}_skills/${orgId}/`,
];

/**
 * An org with something of every kind: a task, rows in a few tables, an object under each prefix, an active secret,
 * a replaced one (a collectable version), a deleted one (a tombstone and a `cleanup-pending` version), a member's
 * own secret, and the secret an authorization records before its grant exists.
 */
async function seed(orgId: string): Promise<SecretRef[]> {
    await craftJob({ sql: db.sql, org: orgId, author: user.id });
    await db.sql`insert into org_plan (org_id, plan, version) values (${orgId}, 'pro', 1)`;
    await db.sql`insert into metric_point (org_id, metric, session_id, value, temporality, time, attrs)
                 values (${orgId}, 'claude_code.token.usage', ${randomUUID()}, 1, 'delta', now(), '{}')`;
    await objects.put(chunkKey(PREFIX, orgId, STREAM, 0), bytes('log'));
    await objects.put(attachmentKey(PREFIX, orgId, randomUUID()), bytes('attachment'));
    await objects.put(skillObjectKey(PREFIX, orgId, 'a'.repeat(64)), bytes('skill'));

    const active = await create(orgSecret(orgId, 'ACTIVE'), 'v1');
    const replaced = await create(orgSecret(orgId, 'REPLACED'), 'v1');
    const swapped = await store.replace({
        identity: orgSecret(orgId, 'REPLACED'),
        ref: replaced.ref,
        operationId: await store.issueOperationId(),
        expectedVersion: replaced.version as never,
        payload: bytes('v2'),
    });
    expect(swapped.ok).toBe(true);
    const deleted = await create(orgSecret(orgId, 'DELETED'), 'v1');
    const gone = await store.delete({
        identity: orgSecret(orgId, 'DELETED'),
        ref: deleted.ref,
        operationId: await store.issueOperationId(),
        expectedVersion: deleted.version as never,
    });
    expect(gone.ok).toBe(true);
    const member = await create(
        { ...orgSecret(orgId, 'MEMBER'), owner: { kind: 'user', userId: user.id, orgId } },
        'mine'
    );
    const pending = await pendingAuthorization(orgId);
    return [active.ref, replaced.ref, deleted.ref, member.ref, pending];
}

/** An authorization interrupted after it recorded its secret and created it, before any grant row exists. */
async function pendingAuthorization(orgId: string): Promise<SecretRef> {
    const grantId = randomUUID();
    const { ref } = await create(grantSecretIdentity({ id: grantId, orgId, principalUserId: user.id }), 'token');
    await db.sql`
        insert into integration_authorization (org_id, user_id, provider, intent, state_hash, return_to, status,
                                               pending_grant_id, secret_ref, expires_at)
        values (${orgId}, ${user.id}, 'jira', 'connect', ${randomUUID()}, '/', 'persisting', ${grantId}, ${ref},
                now() + interval '1 hour')
    `;
    return ref;
}

const suspend = (orgId: string) =>
    db.sql`update organization set status = 'suspended', operator_status = 'suspended' where id = ${orgId}`;

const requestDelete = async (orgId: string) => {
    const asked = await createAuthStore({ sql: db.sql }).requestOrgDelete(orgId, user.id);
    expect(asked.outcome).toBe('requested');
};

/** The org's rows in every registered table, by table. */
async function rowsLeft(orgId: string): Promise<string[]> {
    const left: string[] = [];
    for (const table of ORG_TABLES) {
        const [row] = await db.sql<
            { n: number }[]
        >`select count(*)::int as n from ${db.sql(table)} where org_id = ${orgId}`;
        if (row!.n > 0) left.push(table);
    }
    return left;
}

/** What the secret store still holds for these refs or for any identity the org owns, by kind. */
async function secretsLeft(orgId: string, refs: readonly string[]) {
    const ownerOf = db.sql`case when identity_key::jsonb #>> '{0,0}' = 'organization'
                                then identity_key::jsonb #>> '{0,1}' else identity_key::jsonb #>> '{0,2}' end`;
    const [counts] = await db.sql<{ secrets: number; versions: number; operations: number; owned: number }[]>`
        select (select count(*)::int from secret where ref = any(${refs})) as secrets,
               (select count(*)::int from secret_version where ref = any(${refs})) as versions,
               (select count(*)::int from secret_operation where ref = any(${refs})) as operations,
               (select count(*)::int from secret where ${ownerOf} = ${orgId})
             + (select count(*)::int from secret_operation where ${ownerOf} = ${orgId}) as owned
    `;
    return counts!;
}

async function keysLeft(orgId: string): Promise<string[]> {
    const found: string[] = [];
    for (const prefix of keysOf(orgId)) found.push(...(await objects.list(prefix)));
    return found;
}

const purgeRow = async (orgId: string) =>
    (
        await db.sql<{ step: string; attempts: number; last_error: string | null }[]>`
            select step, attempts, last_error from org_purge where org_id = ${orgId}
        `
    )[0];

const orgExists = async (orgId: string) => (await db.sql`select 1 from organization where id = ${orgId}`).length === 1;

beforeEach(async () => {
    if (!enabled) return;
    provider = new FakeProvider();
    store = createSecretStoreOver({
        repo: createSecretRepo(db.sql),
        keys: new MutableKeys(),
        payloads: provider,
        deadlineMs: 3000,
    });
    objects = createFilesystemStore(await mkdtemp(join(tmpdir(), 'factory-purge-')));
    lines = [];
    await db.sql`update organization set name = ${ACCOUNT_LABEL} where id = ${org}`;
});

describe.skipIf(!enabled)('organization purge', () => {
    it('removes every row, object and secret of a deleted org, leaves an org-less record, and keeps another org whole', async () => {
        const refs = await seed(org);
        const kept = await seed(other);
        await suspend(org);
        await requestDelete(org);

        await runOrgPurgePass(deps());

        expect(await orgExists(org)).toBe(false);
        expect(await rowsLeft(org)).toEqual([]);
        expect(await keysLeft(org)).toEqual([]);
        expect(await secretsLeft(org, refs)).toEqual({ secrets: 0, versions: 0, operations: 0, owned: 0 });
        expect([...provider.objects.keys()].length).toBe((await keptVersions(kept)).length);

        expect(await orgExists(other)).toBe(true);
        expect(await keysLeft(other)).toHaveLength(3);
        expect((await secretsLeft(other, kept)).secrets).toBe(kept.length);

        const records = lines.filter((line) => line.includes('org.purged'));
        expect(records).toHaveLength(1);
        expect(records[0]).toContain(org);
        expect(records[0]).not.toContain(ACCOUNT_LABEL);
    });

    it('finds and removes the secret an authorization left before its grant, and an interrupted create', async () => {
        const recorded = await pendingAuthorization(org);
        provider.failWrite = true;
        const ref = createSecretRef();
        const lost = await store.create({
            identity: orgSecret(org, 'INTERRUPTED'),
            ref,
            operationId: await store.issueOperationId(),
            payload: bytes('half'),
        });
        expect(lost.ok).toBe(false);
        provider.failWrite = false;
        expect((await secretsLeft(org, [ref])).versions).toBe(1);
        await suspend(org);
        await requestDelete(org);

        await runOrgPurgePass(deps());

        expect(await orgExists(org)).toBe(false);
        expect(await secretsLeft(org, [recorded, ref])).toEqual({ secrets: 0, versions: 0, operations: 0, owned: 0 });
        expect(provider.objects.size).toBe(0);
    });

    it('refuses to delete an active org and purges nothing of one that was reactivated', async () => {
        const refs = await seed(org);
        const asked = await createAuthStore({ sql: db.sql }).requestOrgDelete(org, user.id);
        expect(asked.outcome).toBe('active');
        expect(await purgeRow(org)).toBeUndefined();

        await suspend(org);
        await requestDelete(org);
        await db.sql`update organization set status = 'active', operator_status = 'active' where id = ${org}`;
        await runOrgPurgePass(deps());

        expect(await orgExists(org)).toBe(true);
        expect(await keysLeft(org)).toHaveLength(3);
        expect((await secretsLeft(org, refs)).secrets).toBe(refs.length);
        expect(await purgeRow(org)).toMatchObject({ step: 'secrets', last_error: 'org-active' });
    });

    it('answers a second request for the same purge unchanged, and an unknown org missing', async () => {
        await suspend(org);
        await requestDelete(org);
        const auth = createAuthStore({ sql: db.sql });
        expect((await auth.requestOrgDelete(org, user.id)).outcome).toBe('unchanged');
        expect((await auth.requestOrgDelete(testOrg(), user.id)).outcome).toBe('missing');
        const audit = await db.sql<{ action: string; actor_kind: string }[]>`
            select action, actor_kind from audit_event where org_id = ${org} and action = 'org.delete'
        `;
        expect(audit).toEqual([{ action: 'org.delete', actor_kind: 'operator' }]);
    });

    const faults: [string, string, string, (d: OrgPurgeDeps) => OrgPurgeDeps][] = [
        [
            'an object list that fails',
            'objects',
            'object-list-failed',
            (d) => ({
                ...d,
                objects: {
                    ...objects,
                    list: async () => {
                        throw new Error('list refused');
                    },
                },
            }),
        ],
        [
            'an object delete that fails',
            'objects',
            'object-delete-failed',
            (d) => ({
                ...d,
                objects: {
                    ...objects,
                    delete: async () => {
                        throw new Error('delete refused');
                    },
                },
            }),
        ],
        [
            'a secret delete the store cannot confirm',
            'secrets',
            'secret-delete-failed',
            (d) => ({
                ...d,
                secrets: {
                    ...store,
                    delete: async () => ({ ok: false, error: { code: 'unavailable', reason: 'provider-timeout' } }),
                },
            }),
        ],
        [
            'a collector pass that throws',
            'secrets',
            'secret-collect-failed',
            (d) => ({
                ...d,
                secrets: {
                    ...store,
                    collect: async () => {
                        throw new Error('collector down');
                    },
                },
            }),
        ],
        [
            'a collector pass that removes nothing',
            'secrets',
            'secret-versions-remaining',
            (d) => ({ ...d, secrets: { ...store, collect: async () => ({ removed: 0, pruned: 0 }) } }),
        ],
    ];

    it.each(faults)('leaves the purge pending and retries after %s', async (_name, step, error, faulty) => {
        const refs = await seed(org);
        await suspend(org);
        await requestDelete(org);

        await runOrgPurgePass(faulty(deps()));

        expect(await orgExists(org)).toBe(true);
        expect(await purgeRow(org)).toEqual({ step, attempts: 1, last_error: error });
        expect(lines.filter((line) => line.includes('org.purged'))).toEqual([]);

        await runOrgPurgePass(deps());

        expect(await orgExists(org)).toBe(false);
        expect(await rowsLeft(org)).toEqual([]);
        expect(await keysLeft(org)).toEqual([]);
        expect(await secretsLeft(org, refs)).toEqual({ secrets: 0, versions: 0, operations: 0, owned: 0 });
    });

    it('keeps the purge pending while the provider has not confirmed a version gone', async () => {
        const refs = await seed(org);
        await suspend(org);
        await requestDelete(org);
        provider.failRemove = true;

        await runOrgPurgePass(deps());

        expect(await orgExists(org)).toBe(true);
        expect(await purgeRow(org)).toMatchObject({ step: 'secrets', last_error: 'secret-versions-remaining' });
        const [{ n } = { n: 0 }] = await db.sql<{ n: number }[]>`
            select count(*)::int as n from secret_version where ref = any(${refs}) and state = 'deleting'
        `;
        expect(n).toBeGreaterThan(0);

        provider.failRemove = false;
        await runOrgPurgePass(deps());

        expect(await orgExists(org)).toBe(false);
        expect(await secretsLeft(org, refs)).toEqual({ secrets: 0, versions: 0, operations: 0, owned: 0 });
    });

    it.each<[DeploymentMode, boolean]>([
        ['self-hosted', false],
        ['cloud', true],
    ])('purges an org past its deletion deadline on its own in %s mode: %s', async (mode, purged) => {
        await seed(org);
        await db.sql`update organization set status = 'suspended', delete_after = now() - interval '1 minute'
                     where id = ${org}`;
        await db.sql`update organization set status = 'suspended', delete_after = now() + interval '1 day'
                     where id = ${other}`;

        await runOrgPurgePass(deps({ deploymentMode: mode }));

        expect(await orgExists(org)).toBe(!purged);
        expect(await orgExists(other)).toBe(true);
        expect(await purgeRow(other)).toBeUndefined();
    });

    it('purges once when two replicas run a pass together', async () => {
        await seed(org);
        await suspend(org);
        await requestDelete(org);

        await Promise.all([runOrgPurgePass(deps()), runOrgPurgePass(deps())]);
        await runOrgPurgePass(deps());

        expect(await orgExists(org)).toBe(false);
        expect(lines.filter((line) => line.includes('org.purged'))).toHaveLength(1);
    });
});

/** The provider objects another org's live secrets still hold: one per version that is not yet collected. */
async function keptVersions(refs: readonly string[]) {
    return db.sql`select id from secret_version where ref = any(${refs})`;
}
