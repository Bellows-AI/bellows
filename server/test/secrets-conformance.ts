import { createHash, randomUUID } from 'node:crypto';
import { assert, describe, expect, it } from 'vitest';
import { MAX_SECRET_BYTES, OPERATION_RETENTION_MS, createSecretRef } from '../src/secrets/secret-input.js';
import type {
    OperationId,
    SecretError,
    SecretErrorCode,
    SecretErrorReason,
    SecretIdentity,
    SecretRef,
    SecretResult,
    SecretStore,
    SecretVersion,
} from '../src/secrets/secret-store.js';

/**
 * The adapter-agnostic conformance suite for `SecretStore` (docs/secrets.md). A backend supplies a
 * harness; every case drives behavior through the store interface and the harness only, so the
 * reference store and a future database backend (imported from `server/test-db/`) run the same
 * cases. A fault is proven by `reopen()`: a fresh instance over a clone of the durable state,
 * never by reusing one instance's memory.
 */

export type FaultStep = 'after-intent' | 'after-stage' | 'before-activate' | 'after-activate';

/** Thrown by a fault hook to stop an operation mid-flight; a store must never catch it. */
export class SimulatedCrash extends Error {
    constructor(readonly step: FaultStep) {
        super(`simulated crash at ${step}`);
    }
}

export interface SecretStoreFaults {
    onStep: ((event: { step: FaultStep; operationId: OperationId }) => void | Promise<void>) | undefined;
    providerWrite: 'ok' | 'timeout-applied' | 'timeout-lost' | 'unavailable-with-body';
    providerDelete: 'ok' | 'fail';
    providerRead: 'ok' | 'unavailable';
    /** What a failing provider says; a store must never repeat it. */
    providerErrorBody: string;
    /** Provider write attempts so far. */
    providerWriteCount: number;
}

export function createFaults(): SecretStoreFaults {
    return {
        onStep: undefined,
        providerWrite: 'ok',
        providerDelete: 'ok',
        providerRead: 'ok',
        providerErrorBody: '',
        providerWriteCount: 0,
    };
}

export interface SecretStoreHarness {
    /** A fresh instance over the CURRENT durable state (two of them race on shared state). */
    open(): SecretStore;
    /** A fresh instance over a structuredClone of the durable state, which becomes the current one. */
    reopen(): SecretStore;
    clock: { advance(ms: number): void };
    faults: SecretStoreFaults;
    /** Re-encrypt under a new private key id/provider version; the logical version is kept. */
    rekey(identity: SecretIdentity, ref: SecretRef): Promise<void>;
    /** Garbage-collect unreferenced versions and prune completed operations past retention. */
    collect(): Promise<void>;
    /** Corrupt the stored active bytes so integrity verification must fail. */
    tamper(ref: SecretRef): void;
    /** `db` is what PostgreSQL would hold (no payload bytes); other keys stand in for the provider. */
    durableSnapshot(): { db: unknown } & Record<string, unknown>;
    diagnostics(): unknown[];
}

export interface ConformanceCase {
    area: string;
    name: string;
    run(h: SecretStoreHarness): Promise<void>;
}

const bytes = (...n: number[]) => Uint8Array.from(n);
const text = (s: string) => new TextEncoder().encode(s);
const DAY_MS = 24 * 60 * 60 * 1000;

function ok<T extends object>(r: SecretResult<T>): { ok: true } & T {
    if (!r.ok) {
        assert.fail(`expected success, got ${r.error.code}/${r.error.reason}`);
    }
    return r;
}

function fails(r: { ok: boolean }, code: SecretErrorCode, reason: SecretErrorReason): void {
    expect(r).toEqual({ ok: false, error: { code, reason } satisfies SecretError });
}

const unique = (prefix: string) => `${prefix}-${randomUUID()}`;

function orgIdentity(): SecretIdentity {
    return {
        owner: { kind: 'organization', orgId: unique('org') },
        scope: { type: 'workspace', id: unique('ws') },
        purpose: 'environment-secret',
        owningRecord: { type: 'env_var', id: unique('row') },
    };
}

function userIdentity(orgId: string | null = unique('org')): SecretIdentity {
    return {
        owner: { kind: 'user', userId: unique('user'), orgId },
        scope: { type: 'executor-profile', id: unique('profile') },
        purpose: 'executor-credential',
        owningRecord: { type: 'executor_profile', id: unique('rec') },
    };
}

async function seed(store: SecretStore, identity: SecretIdentity, payload: Uint8Array = text('seed')) {
    const ref = createSecretRef();
    const operationId = await store.issueOperationId();
    const created = ok(await store.create({ identity, ref, operationId, payload }));
    return { ref, operationId, version: created.version };
}

async function read(store: SecretStore, identity: SecretIdentity, ref: SecretRef) {
    return store.readActive({ identity, ref });
}

async function expectActive(
    store: SecretStore,
    { identity, ref }: { identity: SecretIdentity; ref: SecretRef },
    payload: Uint8Array,
    version?: SecretVersion
) {
    const r = ok(await read(store, identity, ref));
    expect(Array.from(r.value)).toEqual(Array.from(payload));
    if (version) {
        expect(r.version).toBe(version);
    }
    return r;
}

async function replace(
    store: SecretStore,
    { identity, ref }: { identity: SecretIdentity; ref: SecretRef },
    expectedVersion: SecretVersion,
    payload: Uint8Array
) {
    const operationId = await store.issueOperationId();
    return { operationId, result: await store.replace({ identity, ref, operationId, expectedVersion, payload }) };
}

function crashAt(h: SecretStoreHarness, step: FaultStep, operationId: OperationId): void {
    h.faults.onStep = (event) => {
        if (event.step === step && event.operationId === operationId) {
            throw new SimulatedCrash(step);
        }
    };
}

const noHook = (h: SecretStoreHarness) => {
    h.faults.onStep = undefined;
};

/** Every way an identity can differ from the base one while looking similar. */
function identityVariants(base: SecretIdentity): Array<[string, SecretIdentity]> {
    const variants: Array<[string, SecretIdentity]> = [
        [
            'scope type',
            { ...base, scope: { ...base.scope, type: base.scope.type === 'connection' ? 'repository' : 'connection' } },
        ],
        ['scope id', { ...base, scope: { ...base.scope, id: `${base.scope.id}-x` } }],
        [
            'purpose',
            { ...base, purpose: base.purpose === 'connection-grant' ? 'environment-secret' : 'connection-grant' },
        ],
        [
            'owning record type',
            { ...base, owningRecord: { ...base.owningRecord, type: `${base.owningRecord.type}_x` } },
        ],
        ['owning record id', { ...base, owningRecord: { ...base.owningRecord, id: `${base.owningRecord.id}-x` } }],
    ];
    if (base.owner.kind === 'organization') {
        const { orgId } = base.owner;
        variants.push(
            ['other org', { ...base, owner: { kind: 'organization', orgId: `${orgId}-other` } }],
            ['user with the org id string', { ...base, owner: { kind: 'user', userId: orgId, orgId } }],
            ['user with the org id string and no org', { ...base, owner: { kind: 'user', userId: orgId, orgId: null } }]
        );
    } else {
        const { userId, orgId } = base.owner;
        variants.push(
            ['other user', { ...base, owner: { kind: 'user', userId: `${userId}-other`, orgId } }],
            ['other org', { ...base, owner: { kind: 'user', userId, orgId: `${orgId}-other` } }],
            ...(orgId === null
                ? []
                : ([['no org', { ...base, owner: { kind: 'user', userId, orgId: null } }]] as Array<
                      [string, SecretIdentity]
                  >)),
            ...(orgId === null
                ? []
                : ([
                      ['organization with the user org id', { ...base, owner: { kind: 'organization', orgId } }],
                      [
                          'organization with the user id string',
                          { ...base, owner: { kind: 'organization', orgId: userId } },
                      ],
                  ] as Array<[string, SecretIdentity]>))
        );
    }
    return variants;
}

const identityBases = () => [orgIdentity(), userIdentity(), userIdentity(null)];

function forms(sentinel: string): string[] {
    const raw = Buffer.from(sentinel);
    return [sentinel, raw.toString('hex'), raw.toString('base64'), raw.toString('base64url')];
}

function expectClean(label: string, value: unknown, sentinel: string): void {
    const json = JSON.stringify(value);
    for (const form of forms(sentinel)) {
        expect(json.includes(form), `${label} leaks ${form.slice(0, 12)}...`).toBe(false);
    }
}

/** A run that touches every result shape with the sentinel as the payload; returns what escaped. */
async function sentinelRun(h: SecretStoreHarness, sentinel: string): Promise<unknown[]> {
    const out: unknown[] = [];
    const store = h.open();
    const identity = orgIdentity();
    const payload = text(sentinel);
    const ref = createSecretRef();
    const createOp = await store.issueOperationId();
    const created = ok(await store.create({ identity, ref, operationId: createOp, payload }));
    out.push(created);
    out.push(await store.create({ identity, ref, operationId: createOp, payload }));
    out.push(
        await store.create({ identity: userIdentity(), ref, operationId: await store.issueOperationId(), payload })
    );
    out.push(
        await store.create({
            identity,
            ref: createSecretRef(),
            operationId: await store.issueOperationId(),
            payload: text(sentinel + 'x'.repeat(MAX_SECRET_BYTES)),
        })
    );
    out.push((await replace(store, { identity: identity, ref: ref }, 'stale' as SecretVersion, payload)).result);
    const readBack = ok(await read(store, identity, ref));
    out.push({ ok: readBack.ok, version: readBack.version });
    h.faults.providerWrite = 'timeout-applied';
    const applied = await replace(store, { identity: identity, ref: ref }, created.version, payload);
    out.push(applied.result);
    h.faults.providerWrite = 'ok';
    const fresh = h.reopen();
    out.push(await fresh.reconcileOperation({ identity, ref, operationId: applied.operationId }));
    h.faults.providerWrite = 'unavailable-with-body';
    h.faults.providerErrorBody = `upstream rejected ${sentinel}`;
    out.push((await replace(fresh, { identity: identity, ref: ref }, created.version, payload)).result);
    h.faults.providerWrite = 'ok';
    const current = ok(await read(fresh, identity, ref));
    const deleteOp = await fresh.issueOperationId();
    out.push(await fresh.delete({ identity, ref, operationId: deleteOp, expectedVersion: current.version }));
    out.push(await fresh.reconcileOperation({ identity, ref, operationId: deleteOp }));
    out.push(await read(fresh, identity, ref));
    return out;
}

export const CONFORMANCE_CASES: ConformanceCase[] = [
    // ---- round-trip -------------------------------------------------------------------------
    {
        area: 'round-trip',
        name: 'binary payload round-trips',
        async run(h) {
            const store = h.open();
            const identity = orgIdentity();
            const payload = Uint8Array.from({ length: 256 }, (_, i) => i);
            const s = await seed(store, identity, payload);
            await expectActive(store, { identity: identity, ref: s.ref }, payload, s.version);
        },
    },
    {
        area: 'round-trip',
        name: 'empty payload is valid',
        async run(h) {
            const store = h.open();
            const identity = orgIdentity();
            const s = await seed(store, identity, new Uint8Array(0));
            const r = await expectActive(store, { identity: identity, ref: s.ref }, new Uint8Array(0), s.version);
            expect(r.value.byteLength).toBe(0);
        },
    },
    {
        area: 'round-trip',
        name: '32768 bytes accepted',
        async run(h) {
            const store = h.open();
            const identity = orgIdentity();
            const payload = new Uint8Array(MAX_SECRET_BYTES).fill(7);
            const s = await seed(store, identity, payload);
            await expectActive(store, { identity: identity, ref: s.ref }, payload, s.version);
            const next = await replace(
                store,
                { identity, ref: s.ref },
                s.version,
                payload.map((b) => b + 1)
            );
            ok(next.result);
        },
    },
    {
        area: 'round-trip',
        name: '32769 rejected before side effects',
        async run(h) {
            const store = h.open();
            const identity = orgIdentity();
            const s = await seed(store, identity);
            const before = structuredClone(h.durableSnapshot());
            const writes = h.faults.providerWriteCount;
            const oversize = new Uint8Array(MAX_SECRET_BYTES + 1);
            const createOp = await store.issueOperationId();
            const ref = createSecretRef();
            fails(
                await store.create({ identity, ref, operationId: createOp, payload: oversize }),
                'invalid-input',
                'payload-too-large'
            );
            const replaceOp = await store.issueOperationId();
            fails(
                await store.replace({
                    identity,
                    ref: s.ref,
                    operationId: replaceOp,
                    expectedVersion: s.version,
                    payload: oversize,
                }),
                'invalid-input',
                'payload-too-large'
            );
            expect(h.durableSnapshot()).toEqual(before);
            expect(h.faults.providerWriteCount).toBe(writes);
            // The operation IDs were never consumed: they still work with a valid payload.
            ok(await store.create({ identity, ref, operationId: createOp, payload: bytes(1) }));
            ok(
                await store.replace({
                    identity,
                    ref: s.ref,
                    operationId: replaceOp,
                    expectedVersion: s.version,
                    payload: bytes(2),
                })
            );
        },
    },
    {
        area: 'round-trip',
        name: 'null, undefined and string payloads are rejected as invalid input',
        async run(h) {
            const store = h.open();
            const identity = orgIdentity();
            const s = await seed(store, identity);
            const before = structuredClone(h.durableSnapshot());
            for (const [bad, reason] of [
                [null, 'payload-null'],
                [undefined, 'payload-null'],
                ['text', 'payload-not-bytes'],
            ] as const) {
                const payload = bad as unknown as Uint8Array;
                const operationId = await store.issueOperationId();
                fails(
                    await store.create({ identity, ref: createSecretRef(), operationId, payload }),
                    'invalid-input',
                    reason
                );
                fails(
                    await store.replace({ identity, ref: s.ref, operationId, expectedVersion: s.version, payload }),
                    'invalid-input',
                    reason
                );
            }
            expect(h.durableSnapshot()).toEqual(before);
        },
    },

    // ---- identity ---------------------------------------------------------------------------
    {
        area: 'identity',
        name: 'create with a different identity on an existing reference is an identity mismatch',
        async run(h) {
            const store = h.open();
            for (const base of identityBases()) {
                const s = await seed(store, base);
                for (const [label, variant] of identityVariants(base)) {
                    const operationId = await store.issueOperationId();
                    const r = await store.create({ identity: variant, ref: s.ref, operationId, payload: bytes(9) });
                    expect(r, label).toEqual({
                        ok: false,
                        error: { code: 'identity-mismatch', reason: 'identity-mismatch' },
                    });
                }
                await expectActive(store, { identity: base, ref: s.ref }, text('seed'), s.version);
            }
        },
    },
    {
        area: 'identity',
        name: 'read with a different identity is an identity mismatch',
        async run(h) {
            const store = h.open();
            for (const base of identityBases()) {
                const s = await seed(store, base);
                for (const [label, variant] of identityVariants(base)) {
                    const r = await read(store, variant, s.ref);
                    expect(r, label).toEqual({
                        ok: false,
                        error: { code: 'identity-mismatch', reason: 'identity-mismatch' },
                    });
                }
            }
        },
    },
    {
        area: 'identity',
        name: 'replace with a different identity is an identity mismatch and changes nothing',
        async run(h) {
            const store = h.open();
            for (const base of identityBases()) {
                const s = await seed(store, base);
                for (const [label, variant] of identityVariants(base)) {
                    const { result } = await replace(store, { identity: variant, ref: s.ref }, s.version, bytes(9));
                    expect(result, label).toEqual({
                        ok: false,
                        error: { code: 'identity-mismatch', reason: 'identity-mismatch' },
                    });
                }
                await expectActive(store, { identity: base, ref: s.ref }, text('seed'), s.version);
            }
        },
    },
    {
        area: 'identity',
        name: 'delete with a different identity is an identity mismatch and changes nothing',
        async run(h) {
            const store = h.open();
            for (const base of identityBases()) {
                const s = await seed(store, base);
                for (const [label, variant] of identityVariants(base)) {
                    const operationId = await store.issueOperationId();
                    const r = await store.delete({
                        identity: variant,
                        ref: s.ref,
                        operationId,
                        expectedVersion: s.version,
                    });
                    expect(r, label).toEqual({
                        ok: false,
                        error: { code: 'identity-mismatch', reason: 'identity-mismatch' },
                    });
                }
                await expectActive(store, { identity: base, ref: s.ref }, text('seed'), s.version);
            }
        },
    },
    {
        area: 'identity',
        name: 'operation lookup with a different identity is an identity mismatch',
        async run(h) {
            const store = h.open();
            for (const base of identityBases()) {
                const s = await seed(store, base);
                for (const [label, variant] of identityVariants(base)) {
                    const r = await store.reconcileOperation({
                        identity: variant,
                        ref: s.ref,
                        operationId: s.operationId,
                    });
                    expect(r, label).toEqual({
                        ok: false,
                        error: { code: 'identity-mismatch', reason: 'identity-mismatch' },
                    });
                }
                const own = ok(
                    await store.reconcileOperation({ identity: base, ref: s.ref, operationId: s.operationId })
                );
                expect(own.status).toEqual({ state: 'succeeded', result: { version: s.version } });
            }
        },
    },
    {
        area: 'identity',
        name: 'a personal identity needs no organization and stays distinct from an organization one',
        async run(h) {
            const store = h.open();
            const personal = userIdentity(null);
            const s = await seed(store, personal, text('personal'));
            await expectActive(store, { identity: personal, ref: s.ref }, text('personal'), s.version);
            const withOrg: SecretIdentity = {
                ...personal,
                owner: { ...(personal.owner as { kind: 'user'; userId: string }), orgId: unique('org') },
            };
            fails(await read(store, withOrg, s.ref), 'identity-mismatch', 'identity-mismatch');
            const orgOwned: SecretIdentity = {
                ...personal,
                owner: { kind: 'organization', orgId: (personal.owner as { userId: string }).userId },
            };
            fails(await read(store, orgOwned, s.ref), 'identity-mismatch', 'identity-mismatch');
        },
    },

    // ---- concurrency ------------------------------------------------------------------------
    {
        area: 'concurrency',
        name: 'competing creates: one winner, the other conflicts',
        async run(h) {
            const a = h.open();
            const b = h.open();
            const identity = orgIdentity();
            const ref = createSecretRef();
            const [opA, opB] = [await a.issueOperationId(), await b.issueOperationId()];
            const [ra, rb] = await Promise.all([
                a.create({ identity, ref, operationId: opA, payload: text('A') }),
                b.create({ identity, ref, operationId: opB, payload: text('B') }),
            ]);
            expect([ra.ok, rb.ok].sort()).toEqual([false, true]);
            const loser = ra.ok ? rb : ra;
            fails(loser, 'conflict', 'reference-exists');
            await expectActive(h.open(), { identity: identity, ref: ref }, ra.ok ? text('A') : text('B'));
        },
    },
    {
        area: 'concurrency',
        name: 'replace/replace on the same version: one winner',
        async run(h) {
            const a = h.open();
            const b = h.open();
            const identity = orgIdentity();
            const s = await seed(a, identity);
            const [ra, rb] = await Promise.all([
                replace(a, { identity: identity, ref: s.ref }, s.version, text('A')),
                replace(b, { identity: identity, ref: s.ref }, s.version, text('B')),
            ]);
            expect([ra.result.ok, rb.result.ok].sort()).toEqual([false, true]);
            fails(ra.result.ok ? rb.result : ra.result, 'conflict', 'stale-version');
            await expectActive(h.open(), { identity: identity, ref: s.ref }, ra.result.ok ? text('A') : text('B'));
        },
    },
    {
        area: 'concurrency',
        name: 'replace/delete on the same version: one winner',
        async run(h) {
            const a = h.open();
            const b = h.open();
            const identity = orgIdentity();
            const s = await seed(a, identity);
            const deleteOp = await b.issueOperationId();
            const [rr, rd] = await Promise.all([
                replace(a, { identity: identity, ref: s.ref }, s.version, text('replaced')),
                b.delete({ identity, ref: s.ref, operationId: deleteOp, expectedVersion: s.version }),
            ]);
            expect([rr.result.ok, rd.ok].sort()).toEqual([false, true]);
            const after = await read(h.open(), identity, s.ref);
            if (rr.result.ok) {
                fails(rd, 'conflict', 'stale-version');
                expect(ok(after).value).toEqual(text('replaced'));
            } else {
                fails(rr.result, 'conflict', 'stale-version');
                fails(after, 'not-found', 'reference-not-found');
            }
        },
    },
    {
        area: 'concurrency',
        name: 'a stale expected version conflicts for replace and delete',
        async run(h) {
            const store = h.open();
            const identity = orgIdentity();
            const s = await seed(store, identity);
            const next = ok((await replace(store, { identity: identity, ref: s.ref }, s.version, text('two'))).result);
            fails(
                (await replace(store, { identity: identity, ref: s.ref }, s.version, text('three'))).result,
                'conflict',
                'stale-version'
            );
            const operationId = await store.issueOperationId();
            fails(
                await store.delete({ identity, ref: s.ref, operationId, expectedVersion: s.version }),
                'conflict',
                'stale-version'
            );
            await expectActive(store, { identity: identity, ref: s.ref }, text('two'), next.version);
        },
    },
    {
        area: 'concurrency',
        name: 'replacing with identical bytes yields a new version',
        async run(h) {
            const store = h.open();
            const identity = orgIdentity();
            const s = await seed(store, identity, text('same'));
            const next = ok((await replace(store, { identity: identity, ref: s.ref }, s.version, text('same'))).result);
            expect(next.version).not.toBe(s.version);
            await expectActive(store, { identity: identity, ref: s.ref }, text('same'), next.version);
        },
    },
    {
        area: 'concurrency',
        name: 'rekey keeps the logical version and bytes, and the pre-rekey version still replaces',
        async run(h) {
            const store = h.open();
            const identity = orgIdentity();
            const s = await seed(store, identity, text('rekeyed'));
            await h.rekey(identity, s.ref);
            await expectActive(store, { identity: identity, ref: s.ref }, text('rekeyed'), s.version);
            const next = ok(
                (await replace(store, { identity: identity, ref: s.ref }, s.version, text('after'))).result
            );
            expect(next.version).not.toBe(s.version);
        },
    },
    {
        area: 'concurrency',
        name: 'create on a tombstoned reference conflicts and the reference is never reused',
        async run(h) {
            const store = h.open();
            const identity = orgIdentity();
            const s = await seed(store, identity);
            ok(
                await store.delete({
                    identity,
                    ref: s.ref,
                    operationId: await store.issueOperationId(),
                    expectedVersion: s.version,
                })
            );
            const again = await store.create({
                identity,
                ref: s.ref,
                operationId: await store.issueOperationId(),
                payload: text('again'),
            });
            fails(again, 'conflict', 'reference-exists');
            fails(await read(store, identity, s.ref), 'not-found', 'reference-not-found');
            fails(
                (await replace(store, { identity: identity, ref: s.ref }, s.version, text('x'))).result,
                'not-found',
                'reference-not-found'
            );
        },
    },
    {
        area: 'concurrency',
        name: 'a fresh delete of a deleted or missing reference is not-found; replaying the delete returns its success',
        async run(h) {
            const store = h.open();
            const identity = orgIdentity();
            const s = await seed(store, identity);
            const deleteOp = await store.issueOperationId();
            const first = ok(
                await store.delete({ identity, ref: s.ref, operationId: deleteOp, expectedVersion: s.version })
            );
            fails(
                await store.delete({
                    identity,
                    ref: s.ref,
                    operationId: await store.issueOperationId(),
                    expectedVersion: s.version,
                }),
                'not-found',
                'reference-not-found'
            );
            fails(
                await store.delete({
                    identity,
                    ref: createSecretRef(),
                    operationId: await store.issueOperationId(),
                    expectedVersion: s.version,
                }),
                'not-found',
                'reference-not-found'
            );
            const replay = await store.delete({
                identity,
                ref: s.ref,
                operationId: deleteOp,
                expectedVersion: s.version,
            });
            expect(replay).toEqual(first);
        },
    },

    // ---- retry ------------------------------------------------------------------------------
    {
        area: 'retry',
        name: 'an identical replay returns the original result without writing again',
        async run(h) {
            const store = h.open();
            const identity = orgIdentity();
            const ref = createSecretRef();
            const createOp = await store.issueOperationId();
            const created = await store.create({ identity, ref, operationId: createOp, payload: text('one') });
            const writes = h.faults.providerWriteCount;
            expect(await store.create({ identity, ref, operationId: createOp, payload: text('one') })).toEqual(created);
            const version = ok(created).version;
            const { operationId, result } = await replace(
                store,
                { identity: identity, ref: ref },
                version,
                text('two')
            );
            expect(
                await store.replace({ identity, ref, operationId, expectedVersion: version, payload: text('two') })
            ).toEqual(result);
            const deleteOp = await store.issueOperationId();
            const del = await store.delete({
                identity,
                ref,
                operationId: deleteOp,
                expectedVersion: ok(result).version,
            });
            expect(
                await store.delete({ identity, ref, operationId: deleteOp, expectedVersion: ok(result).version })
            ).toEqual(del);
            expect(h.faults.providerWriteCount).toBe(writes + 1);
        },
    },
    {
        area: 'retry',
        name: 'a failed delete binds its operation ID',
        async run(h) {
            const store = h.open();
            const identity = orgIdentity();
            const ref = createSecretRef();
            const operationId = await store.issueOperationId();
            const input = { identity, ref, operationId, expectedVersion: 'ver_none' as SecretVersion };
            fails(await store.delete(input), 'not-found', 'reference-not-found');
            fails(await store.delete(input), 'not-found', 'reference-not-found');
            fails(await h.reopen().delete(input), 'not-found', 'reference-not-found');
            fails(
                await store.create({ identity, ref, operationId, payload: text('other') }),
                'conflict',
                'operation-id-reused'
            );
            fails(await read(store, identity, ref), 'not-found', 'reference-not-found');
            const created = await seed(store, identity);
            fails(await store.delete({ ...input, ref: created.ref }), 'conflict', 'operation-id-reused');
            await expectActive(store, { identity, ref: created.ref }, text('seed'));
        },
    },
    {
        area: 'retry',
        name: 'a stale-version replace binds its operation ID',
        async run(h) {
            const store = h.open();
            const identity = orgIdentity();
            const s = await seed(store, identity, text('one'));
            const next = ok((await replace(store, { identity, ref: s.ref }, s.version, text('two'))).result);
            const operationId = await store.issueOperationId();
            const stale = { identity, ref: s.ref, operationId, expectedVersion: s.version, payload: text('three') };
            fails(await store.replace(stale), 'conflict', 'stale-version');
            fails(await h.reopen().replace(stale), 'conflict', 'stale-version');
            fails(await store.replace({ ...stale, payload: text('changed') }), 'conflict', 'operation-id-reused');
            fails(
                await store.create({ identity, ref: createSecretRef(), operationId, payload: text('x') }),
                'conflict',
                'operation-id-reused'
            );
            await expectActive(store, { identity, ref: s.ref }, text('two'), next.version);
        },
    },
    {
        area: 'retry',
        name: 'a reference-exists create binds its operation ID',
        async run(h) {
            const store = h.open();
            const identity = orgIdentity();
            const s = await seed(store, identity, text('one'));
            const operationId = await store.issueOperationId();
            const again = { identity, ref: s.ref, operationId, payload: text('two') };
            fails(await store.create(again), 'conflict', 'reference-exists');
            fails(await h.reopen().create(again), 'conflict', 'reference-exists');
            fails(await store.create({ ...again, payload: text('changed') }), 'conflict', 'operation-id-reused');
            fails(
                await store.delete({ identity, ref: s.ref, operationId, expectedVersion: s.version }),
                'conflict',
                'operation-id-reused'
            );
            await expectActive(store, { identity, ref: s.ref }, text('one'), s.version);
        },
    },
    {
        area: 'payload',
        name: 'a caller buffer mutated during create is never stored',
        async run(h) {
            const store = h.open();
            const identity = orgIdentity();
            const ref = createSecretRef();
            const operationId = await store.issueOperationId();
            const buffer = bytes(1);
            const pending = store.create({ identity, ref, operationId, payload: buffer });
            buffer[0] = 2;
            const created = ok(await pending);
            await expectActive(store, { identity, ref }, bytes(1), created.version);
            expect(ok(await store.create({ identity, ref, operationId, payload: bytes(1) })).version).toBe(
                created.version
            );
            fails(
                await store.create({ identity, ref, operationId, payload: bytes(2) }),
                'conflict',
                'operation-id-reused'
            );
        },
    },
    {
        area: 'payload',
        name: 'a caller buffer mutated during replace is never stored',
        async run(h) {
            const store = h.open();
            const identity = orgIdentity();
            const s = await seed(store, identity, bytes(0));
            const operationId = await store.issueOperationId();
            const buffer = bytes(1);
            const pending = store.replace({
                identity,
                ref: s.ref,
                operationId,
                expectedVersion: s.version,
                payload: buffer,
            });
            buffer[0] = 2;
            const next = ok(await pending);
            await expectActive(store, { identity, ref: s.ref }, bytes(1), next.version);
            const replay = { identity, ref: s.ref, operationId, expectedVersion: s.version };
            expect(ok(await store.replace({ ...replay, payload: bytes(1) })).version).toBe(next.version);
            fails(await store.replace({ ...replay, payload: bytes(2) }), 'conflict', 'operation-id-reused');
        },
    },
    {
        area: 'payload',
        name: 'mutating a returned secret leaves stored state unchanged',
        async run(h) {
            const store = h.open();
            const identity = orgIdentity();
            const s = await seed(store, identity, bytes(7, 8));
            const first = ok(await read(store, identity, s.ref));
            first.value.fill(0);
            await expectActive(store, { identity, ref: s.ref }, bytes(7, 8), s.version);
        },
    },
    {
        area: 'input',
        name: 'a null scope or owning record is invalid input with no side effect',
        async run(h) {
            const store = h.open();
            const good = orgIdentity();
            const s = await seed(store, good);
            const before = structuredClone(h.durableSnapshot());
            const broken = [
                { ...good, scope: null },
                { ...good, owningRecord: null },
            ] as unknown as SecretIdentity[];
            const settled = async <T>(call: () => Promise<T>): Promise<T> =>
                call().catch((error: unknown) => assert.fail(`the store threw instead of failing: ${String(error)}`));
            for (const identity of broken) {
                const operationId = await store.issueOperationId();
                const invalid = (r: { ok: boolean }) => fails(r, 'invalid-input', 'identity-invalid');
                invalid(
                    await settled(() =>
                        store.create({ identity, ref: createSecretRef(), operationId, payload: bytes(1) })
                    )
                );
                invalid(
                    await settled(() =>
                        store.replace({
                            identity,
                            ref: s.ref,
                            operationId,
                            expectedVersion: s.version,
                            payload: bytes(1),
                        })
                    )
                );
                invalid(
                    await settled(() => store.delete({ identity, ref: s.ref, operationId, expectedVersion: s.version }))
                );
                invalid(await settled(() => store.readActive({ identity, ref: s.ref })));
                invalid(await settled(() => store.reconcileOperation({ identity, ref: s.ref, operationId })));
            }
            expect(h.durableSnapshot()).toEqual(before);
        },
    },
    {
        area: 'retry',
        name: 'reusing an operation ID with different input conflicts',
        async run(h) {
            const store = h.open();
            const identity = orgIdentity();
            const s = await seed(store, identity, text('one'));
            const { operationId } = await replace(store, { identity: identity, ref: s.ref }, s.version, text('two'));
            const replaced = ok(await store.reconcileOperation({ identity, ref: s.ref, operationId })).status;
            assert(replaced.state === 'succeeded');
            const reused = (r: { ok: boolean }) => fails(r, 'conflict', 'operation-id-reused');
            reused(await store.create({ identity, ref: s.ref, operationId, payload: text('two') }));
            reused(
                await store.replace({
                    identity,
                    ref: s.ref,
                    operationId,
                    expectedVersion: s.version,
                    payload: text('other'),
                })
            );
            reused(
                await store.replace({
                    identity,
                    ref: s.ref,
                    operationId,
                    expectedVersion: 'other' as SecretVersion,
                    payload: text('two'),
                })
            );
            reused(
                await store.replace({
                    identity,
                    ref: createSecretRef(),
                    operationId,
                    expectedVersion: s.version,
                    payload: text('two'),
                })
            );
            reused(await store.delete({ identity, ref: s.ref, operationId, expectedVersion: s.version }));
            await expectActive(store, { identity: identity, ref: s.ref }, text('two'));
        },
    },
    {
        area: 'retry',
        name: 'a replay after later updates or deletion returns the original and never reactivates the old value',
        async run(h) {
            const store = h.open();
            const identity = orgIdentity();
            const ref = createSecretRef();
            const createOp = await store.issueOperationId();
            const created = ok(await store.create({ identity, ref, operationId: createOp, payload: text('one') }));
            const second = await replace(store, { identity: identity, ref: ref }, created.version, text('two'));
            const secondOk = ok(second.result);
            const replayCreate = await store.create({ identity, ref, operationId: createOp, payload: text('one') });
            expect(replayCreate).toEqual({ ok: true, version: created.version });
            await expectActive(store, { identity: identity, ref: ref }, text('two'), secondOk.version);
            const deleteOp = await store.issueOperationId();
            ok(await store.delete({ identity, ref, operationId: deleteOp, expectedVersion: secondOk.version }));
            const replayReplace = await store.replace({
                identity,
                ref,
                operationId: second.operationId,
                expectedVersion: created.version,
                payload: text('two'),
            });
            expect(replayReplace).toEqual(second.result);
            expect(await store.create({ identity, ref, operationId: createOp, payload: text('one') })).toEqual(
                replayCreate
            );
            fails(await read(store, identity, ref), 'not-found', 'reference-not-found');
        },
    },
    {
        area: 'retry',
        name: 'an expired operation ID is rejected without a write once the retention window passes',
        async run(h) {
            const store = h.open();
            const identity = orgIdentity();
            const ref = createSecretRef();
            const operationId = await store.issueOperationId();
            const created = ok(await store.create({ identity, ref, operationId, payload: text('one') }));
            const writes = h.faults.providerWriteCount;
            const input = { identity, ref, operationId, payload: text('one') };
            h.clock.advance(OPERATION_RETENTION_MS);
            await h.collect();
            expect(await store.create(input)).toEqual({ ok: true, version: created.version });
            h.clock.advance(1);
            await h.collect();
            fails(await h.reopen().create(input), 'invalid-input', 'operation-id-expired');
            fails(
                await h.open().reconcileOperation({ identity, ref, operationId }),
                'invalid-input',
                'operation-id-expired'
            );
            expect(h.faults.providerWriteCount).toBe(writes);
            await expectActive(h.open(), { identity: identity, ref: ref }, text('one'), created.version);
            // An ID that was issued long ago and never used is expired too, before any record exists.
            const stale = await h.open().issueOperationId();
            h.clock.advance(OPERATION_RETENTION_MS + 1);
            fails(
                await h.open().create({ identity, ref: createSecretRef(), operationId: stale, payload: text('x') }),
                'invalid-input',
                'operation-id-expired'
            );
        },
    },
    {
        area: 'retry',
        name: 'an unresolved operation older than the retention window stays reconcilable and resumable',
        async run(h) {
            const store = h.open();
            const identity = orgIdentity();
            const s = await seed(store, identity, text('one'));
            const reconcilable = await store.issueOperationId();
            crashAt(h, 'after-stage', reconcilable);
            await expect(
                store.replace({
                    identity,
                    ref: s.ref,
                    operationId: reconcilable,
                    expectedVersion: s.version,
                    payload: text('two'),
                })
            ).rejects.toBeInstanceOf(SimulatedCrash);
            const resumable = await store.issueOperationId();
            const other = await seed(store, identity, text('uno'));
            crashAt(h, 'after-intent', resumable);
            await expect(
                store.replace({
                    identity,
                    ref: other.ref,
                    operationId: resumable,
                    expectedVersion: other.version,
                    payload: text('dos'),
                })
            ).rejects.toBeInstanceOf(SimulatedCrash);
            noHook(h);
            h.clock.advance(8 * DAY_MS);
            await h.collect();
            const fresh = h.reopen();
            const status = ok(
                await fresh.reconcileOperation({ identity, ref: s.ref, operationId: reconcilable })
            ).status;
            expect(status.state).toBe('succeeded');
            await expectActive(fresh, { identity: identity, ref: s.ref }, text('two'));
            const resumed = await fresh.replace({
                identity,
                ref: other.ref,
                operationId: resumable,
                expectedVersion: other.version,
                payload: text('dos'),
            });
            ok(resumed);
            await expectActive(fresh, { identity: identity, ref: other.ref }, text('dos'));
        },
    },
    {
        area: 'retry',
        name: 'a tampered or malformed operation ID is invalid input',
        async run(h) {
            const store = h.open();
            const identity = orgIdentity();
            const real = await store.issueOperationId();
            const last = real.slice(-1) === '0' ? '1' : '0';
            for (const bad of [`${real.slice(0, -1)}${last}`, 'op_x', '', 'not-an-operation-id']) {
                fails(
                    await store.create({
                        identity,
                        ref: createSecretRef(),
                        operationId: bad as OperationId,
                        payload: text('x'),
                    }),
                    'invalid-input',
                    'operation-id-invalid'
                );
            }
        },
    },
    {
        area: 'retry',
        name: 'a fresh mutation is blocked behind an unknown operation but not behind a pending one',
        async run(h) {
            const store = h.open();
            const identity = orgIdentity();
            const s = await seed(store, identity, text('one'));
            h.faults.providerWrite = 'timeout-lost';
            const first = await replace(store, { identity: identity, ref: s.ref }, s.version, text('two'));
            fails(first.result, 'outcome-unknown', 'provider-timeout');
            h.faults.providerWrite = 'ok';
            const fresh = h.reopen();
            fails(
                (await replace(fresh, { identity: identity, ref: s.ref }, s.version, text('three'))).result,
                'conflict',
                'operation-pending'
            );
            const resumed = ok(
                await fresh.replace({
                    identity,
                    ref: s.ref,
                    operationId: first.operationId,
                    expectedVersion: s.version,
                    payload: text('two'),
                })
            );
            ok((await replace(fresh, { identity: identity, ref: s.ref }, resumed.version, text('three'))).result);

            const other = await seed(fresh, identity, text('uno'));
            const crashed = await fresh.issueOperationId();
            crashAt(h, 'after-stage', crashed);
            await expect(
                fresh.replace({
                    identity,
                    ref: other.ref,
                    operationId: crashed,
                    expectedVersion: other.version,
                    payload: text('dos'),
                })
            ).rejects.toBeInstanceOf(SimulatedCrash);
            noHook(h);
            const after = h.reopen();
            ok((await replace(after, { identity: identity, ref: other.ref }, other.version, text('tres'))).result);
        },
    },

    // ---- faults -----------------------------------------------------------------------------
    {
        area: 'faults',
        name: 'a crash after staging, before activation: the old value stays active and reconcile rolls forward',
        async run(h) {
            const store = h.open();
            const identity = userIdentity();
            const s = await seed(store, identity, text('one'));
            const operationId = await store.issueOperationId();
            crashAt(h, 'after-stage', operationId);
            await expect(
                store.replace({ identity, ref: s.ref, operationId, expectedVersion: s.version, payload: text('two') })
            ).rejects.toBeInstanceOf(SimulatedCrash);
            noHook(h);
            const fresh = h.reopen();
            await expectActive(fresh, { identity: identity, ref: s.ref }, text('one'), s.version);
            const status = ok(await fresh.reconcileOperation({ identity, ref: s.ref, operationId })).status;
            assert(status.state === 'succeeded');
            await expectActive(
                fresh,
                { identity: identity, ref: s.ref },
                text('two'),
                status.result.version as SecretVersion
            );
        },
    },
    {
        area: 'faults',
        name: 'a crash before activation never overwrites a newer winner when reconciled',
        async run(h) {
            const store = h.open();
            const identity = orgIdentity();
            const s = await seed(store, identity, text('one'));
            const loser = await store.issueOperationId();
            crashAt(h, 'after-stage', loser);
            await expect(
                store.replace({
                    identity,
                    ref: s.ref,
                    operationId: loser,
                    expectedVersion: s.version,
                    payload: text('stale'),
                })
            ).rejects.toBeInstanceOf(SimulatedCrash);
            noHook(h);
            const fresh = h.reopen();
            const winner = ok(
                (await replace(fresh, { identity: identity, ref: s.ref }, s.version, text('winner'))).result
            );
            const status = ok(await fresh.reconcileOperation({ identity, ref: s.ref, operationId: loser })).status;
            expect(status).toEqual({ state: 'failed', error: { code: 'conflict', reason: 'stale-version' } });
            await expectActive(h.reopen(), { identity: identity, ref: s.ref }, text('winner'), winner.version);
        },
    },
    {
        area: 'faults',
        name: 'reconcile never resurrects a deleted secret',
        async run(h) {
            const store = h.open();
            const identity = orgIdentity();
            const s = await seed(store, identity, text('one'));
            const interrupted = await store.issueOperationId();
            crashAt(h, 'after-stage', interrupted);
            await expect(
                store.replace({
                    identity,
                    ref: s.ref,
                    operationId: interrupted,
                    expectedVersion: s.version,
                    payload: text('two'),
                })
            ).rejects.toBeInstanceOf(SimulatedCrash);
            noHook(h);
            const fresh = h.reopen();
            ok(
                await fresh.delete({
                    identity,
                    ref: s.ref,
                    operationId: await fresh.issueOperationId(),
                    expectedVersion: s.version,
                })
            );
            const status = ok(
                await fresh.reconcileOperation({ identity, ref: s.ref, operationId: interrupted })
            ).status;
            expect(status.state).toBe('failed');
            fails(await read(h.reopen(), identity, s.ref), 'not-found', 'reference-not-found');
        },
    },
    {
        area: 'faults',
        name: 'an ambiguous provider timeout that was applied is outcome-unknown and reconciles without a double write',
        async run(h) {
            const store = h.open();
            const identity = orgIdentity();
            const s = await seed(store, identity, text('one'));
            h.faults.providerWrite = 'timeout-applied';
            const attempt = await replace(store, { identity: identity, ref: s.ref }, s.version, text('two'));
            fails(attempt.result, 'outcome-unknown', 'provider-timeout');
            h.faults.providerWrite = 'ok';
            const fresh = h.reopen();
            await expectActive(fresh, { identity: identity, ref: s.ref }, text('one'), s.version);
            const status = ok(
                await fresh.reconcileOperation({ identity, ref: s.ref, operationId: attempt.operationId })
            ).status;
            expect(['unknown', 'succeeded']).toContain(status.state);
            const replay = ok(
                await fresh.replace({
                    identity,
                    ref: s.ref,
                    operationId: attempt.operationId,
                    expectedVersion: s.version,
                    payload: text('two'),
                })
            );
            if (status.state === 'succeeded') {
                expect(replay.version).toBe(status.result.version);
            }
            await expectActive(fresh, { identity: identity, ref: s.ref }, text('two'), replay.version);
        },
    },
    {
        area: 'faults',
        name: 'an ambiguous provider timeout that was lost stays unknown, never failed, and replay resumes it',
        async run(h) {
            const store = h.open();
            const identity = orgIdentity();
            const s = await seed(store, identity, text('one'));
            h.faults.providerWrite = 'timeout-lost';
            const attempt = await replace(store, { identity: identity, ref: s.ref }, s.version, text('two'));
            fails(attempt.result, 'outcome-unknown', 'provider-timeout');
            h.faults.providerWrite = 'ok';
            const fresh = h.reopen();
            const status = ok(
                await fresh.reconcileOperation({ identity, ref: s.ref, operationId: attempt.operationId })
            ).status;
            expect(status).toEqual({ state: 'unknown' });
            await expectActive(fresh, { identity: identity, ref: s.ref }, text('one'), s.version);
            const replay = ok(
                await fresh.replace({
                    identity,
                    ref: s.ref,
                    operationId: attempt.operationId,
                    expectedVersion: s.version,
                    payload: text('two'),
                })
            );
            await expectActive(fresh, { identity: identity, ref: s.ref }, text('two'), replay.version);
        },
    },
    {
        area: 'faults',
        name: 'a lost response after activation: reconcile reports success and a replay does not write twice',
        async run(h) {
            const store = h.open();
            const identity = orgIdentity();
            const s = await seed(store, identity, text('one'));
            const operationId = await store.issueOperationId();
            crashAt(h, 'after-activate', operationId);
            await expect(
                store.replace({ identity, ref: s.ref, operationId, expectedVersion: s.version, payload: text('two') })
            ).rejects.toBeInstanceOf(SimulatedCrash);
            noHook(h);
            const writes = h.faults.providerWriteCount;
            const fresh = h.reopen();
            const status = ok(await fresh.reconcileOperation({ identity, ref: s.ref, operationId })).status;
            assert(status.state === 'succeeded');
            const replay = ok(
                await fresh.replace({
                    identity,
                    ref: s.ref,
                    operationId,
                    expectedVersion: s.version,
                    payload: text('two'),
                })
            );
            expect(replay.version).toBe(status.result.version);
            expect(h.faults.providerWriteCount).toBe(writes);
            await expectActive(fresh, { identity: identity, ref: s.ref }, text('two'), replay.version);
        },
    },
    {
        area: 'faults',
        name: 'an activation conflict loses cleanly: the winner stays, the loser is failed and stays failed',
        async run(h) {
            const a = h.open();
            const b = h.open();
            const identity = orgIdentity();
            const s = await seed(a, identity, text('one'));
            const operationId = await a.issueOperationId();
            let release!: () => void;
            let arrive!: () => void;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            const arrived = new Promise<void>((resolve) => {
                arrive = resolve;
            });
            h.faults.onStep = async (event) => {
                if (event.step === 'before-activate' && event.operationId === operationId) {
                    arrive();
                    await gate;
                }
            };
            const paused = a.replace({
                identity,
                ref: s.ref,
                operationId,
                expectedVersion: s.version,
                payload: text('loser'),
            });
            await arrived;
            const winner = ok((await replace(b, { identity: identity, ref: s.ref }, s.version, text('winner'))).result);
            release();
            fails(await paused, 'conflict', 'stale-version');
            noHook(h);
            const fresh = h.reopen();
            await expectActive(fresh, { identity: identity, ref: s.ref }, text('winner'), winner.version);
            const status = ok(await fresh.reconcileOperation({ identity, ref: s.ref, operationId })).status;
            expect(status).toEqual({ state: 'failed', error: { code: 'conflict', reason: 'stale-version' } });
            await h.collect();
            await expectActive(h.reopen(), { identity: identity, ref: s.ref }, text('winner'), winner.version);
        },
    },
    {
        area: 'faults',
        name: 'failed deletion cleanup never restores resolution',
        async run(h) {
            const store = h.open();
            const identity = orgIdentity();
            const s = await seed(store, identity, text('one'));
            h.faults.providerDelete = 'fail';
            ok(
                await store.delete({
                    identity,
                    ref: s.ref,
                    operationId: await store.issueOperationId(),
                    expectedVersion: s.version,
                })
            );
            fails(await read(store, identity, s.ref), 'not-found', 'reference-not-found');
            await h.collect();
            const fresh = h.reopen();
            fails(await read(fresh, identity, s.ref), 'not-found', 'reference-not-found');
            h.faults.providerDelete = 'ok';
            await h.collect();
            const again = h.reopen();
            fails(await read(again, identity, s.ref), 'not-found', 'reference-not-found');
            fails(
                await again.create({
                    identity,
                    ref: s.ref,
                    operationId: await again.issueOperationId(),
                    payload: text('x'),
                }),
                'conflict',
                'reference-exists'
            );
        },
    },
    {
        area: 'faults',
        name: 'collection never removes an active version or one a pending operation references',
        async run(h) {
            const store = h.open();
            const identity = orgIdentity();
            const s = await seed(store, identity, text('one'));
            const two = ok((await replace(store, { identity: identity, ref: s.ref }, s.version, text('two'))).result);
            const pending = await store.issueOperationId();
            crashAt(h, 'after-stage', pending);
            await expect(
                store.replace({
                    identity,
                    ref: s.ref,
                    operationId: pending,
                    expectedVersion: two.version,
                    payload: text('three'),
                })
            ).rejects.toBeInstanceOf(SimulatedCrash);
            noHook(h);
            await h.collect();
            const fresh = h.reopen();
            await expectActive(fresh, { identity: identity, ref: s.ref }, text('two'), two.version);
            const status = ok(await fresh.reconcileOperation({ identity, ref: s.ref, operationId: pending })).status;
            expect(status.state).toBe('succeeded');
            await expectActive(fresh, { identity: identity, ref: s.ref }, text('three'));
        },
    },
    {
        area: 'faults',
        name: 'an already-aborted signal is unavailable and writes nothing',
        async run(h) {
            const store = h.open();
            const identity = orgIdentity();
            const s = await seed(store, identity);
            const before = structuredClone(h.durableSnapshot());
            const writes = h.faults.providerWriteCount;
            const controller = new AbortController();
            controller.abort();
            const operationId = await store.issueOperationId();
            fails(
                await store.replace({
                    identity,
                    ref: s.ref,
                    operationId,
                    expectedVersion: s.version,
                    payload: text('x'),
                    signal: controller.signal,
                }),
                'unavailable',
                'aborted'
            );
            expect(h.durableSnapshot()).toEqual(before);
            expect(h.faults.providerWriteCount).toBe(writes);
        },
    },
    {
        area: 'faults',
        name: 'tampered stored bytes are an integrity failure',
        async run(h) {
            const store = h.open();
            const identity = orgIdentity();
            const s = await seed(store, identity, text('intact'));
            h.tamper(s.ref);
            fails(await read(h.reopen(), identity, s.ref), 'integrity-failure', 'integrity-check-failed');
        },
    },
    {
        area: 'faults',
        name: 'a provider read error is unavailable, not not-found',
        async run(h) {
            const store = h.open();
            const identity = orgIdentity();
            const s = await seed(store, identity);
            h.faults.providerRead = 'unavailable';
            fails(await read(store, identity, s.ref), 'unavailable', 'provider-unavailable');
            h.faults.providerRead = 'ok';
            await expectActive(store, { identity: identity, ref: s.ref }, text('seed'), s.version);
        },
    },

    // ---- sanitization -----------------------------------------------------------------------
    {
        area: 'sanitization',
        name: 'the sentinel never escapes through errors, results, diagnostics or durable recovery metadata',
        async run(h) {
            const sentinel = `SENTINEL-${randomUUID()}-payload`;
            const out = await sentinelRun(h, sentinel);
            expectClean('results and errors', out, sentinel);
            expectClean('diagnostics', h.diagnostics(), sentinel);
            expectClean('durable db', h.durableSnapshot().db, sentinel);
        },
    },
    {
        area: 'sanitization',
        name: 'no unkeyed digest of the payload reaches durable recovery metadata',
        async run(h) {
            const sentinel = `SENTINEL-${randomUUID()}-payload`;
            await sentinelRun(h, sentinel);
            const db = JSON.stringify(h.durableSnapshot().db);
            for (const algorithm of ['sha256', 'sha1', 'md5', 'sha512']) {
                const digest = createHash(algorithm).update(sentinel).digest();
                for (const form of [digest.toString('hex'), digest.toString('base64'), digest.toString('base64url')]) {
                    expect(db.includes(form), `db holds an unkeyed ${algorithm}`).toBe(false);
                }
            }
        },
    },
    {
        area: 'sanitization',
        name: 'a provider error body maps to unavailable and is never repeated',
        async run(h) {
            const sentinel = `SENTINEL-${randomUUID()}-body`;
            const store = h.open();
            const identity = orgIdentity();
            const s = await seed(store, identity, text('one'));
            h.faults.providerWrite = 'unavailable-with-body';
            h.faults.providerErrorBody = `provider said ${sentinel}`;
            const attempt = await replace(store, { identity: identity, ref: s.ref }, s.version, text('two'));
            fails(attempt.result, 'unavailable', 'provider-unavailable');
            expectClean('result', attempt.result, sentinel);
            expectClean('diagnostics', h.diagnostics(), sentinel);
            expectClean('durable db', h.durableSnapshot().db, sentinel);
            h.faults.providerWrite = 'ok';
            await expectActive(store, { identity: identity, ref: s.ref }, text('one'), s.version);
            ok(
                await store.replace({
                    identity,
                    ref: s.ref,
                    operationId: attempt.operationId,
                    expectedVersion: s.version,
                    payload: text('two'),
                })
            );
        },
    },
];

export function describeSecretStoreConformance(
    name: string,
    makeHarness: () => SecretStoreHarness | Promise<SecretStoreHarness>
): void {
    describe(`${name} satisfies the SecretStore contract`, () => {
        for (const c of CONFORMANCE_CASES) {
            it(`${c.area}: ${c.name}`, async () => {
                await c.run(await makeHarness());
            });
        }
    });
}
