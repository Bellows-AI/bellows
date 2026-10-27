import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTestDb } from './harness.js';
import { createPostgresHarness, createSecret, testIdentity, utf8 } from './secrets-postgres-harness.js';

const enabled = Boolean(process.env.DATABASE_URL);
const db = useTestDb({ max: 8 });

const forms = (value: string | Buffer) => {
    const raw = Buffer.from(value);
    return [
        ...(typeof value === 'string' ? [value] : []),
        raw.toString('hex'),
        raw.toString('base64'),
        raw.toString('base64url'),
    ];
};

afterEach(() => {
    vi.restoreAllMocks();
});

describe.skipIf(!enabled)('sanitization', () => {
    it('a payload, an error body and the key bytes never reach results, errors, diagnostics, console or the catalog', async () => {
        const logged: string[] = [];
        for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
            vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
                logged.push(JSON.stringify(args));
            });
        }
        const h = createPostgresHarness(db.sql, { deadlineMs: 200 });
        const payloadSentinel = `SENTINEL-${crypto.randomUUID()}-payload`;
        const bodySentinel = `SENTINEL-${crypto.randomUUID()}-body`;
        const identity = testIdentity();
        const store = h.open();
        const seen: unknown[] = [];

        const s = await createSecret(store, identity, utf8(payloadSentinel));
        seen.push(s);
        const replaceOp = await store.issueOperationId();
        h.faults.providerWrite = 'unavailable-with-body';
        h.faults.providerErrorBody = `database said ${bodySentinel}`;
        seen.push(
            await store.replace({
                identity,
                ref: s.ref,
                operationId: replaceOp,
                expectedVersion: s.version,
                payload: utf8(payloadSentinel),
            })
        );
        h.faults.providerWrite = 'timeout-lost';
        seen.push(
            await store.replace({
                identity,
                ref: s.ref,
                operationId: replaceOp,
                expectedVersion: s.version,
                payload: utf8(payloadSentinel),
            })
        );
        h.faults.providerWrite = 'ok';
        seen.push(await store.reconcileOperation({ identity, ref: s.ref, operationId: replaceOp }));
        seen.push(
            await store.replace({
                identity,
                ref: s.ref,
                operationId: replaceOp,
                expectedVersion: s.version,
                payload: utf8(payloadSentinel),
            })
        );
        const read = await store.readActive({ identity, ref: s.ref });
        expect(read.ok && new TextDecoder().decode(read.value)).toBe(payloadSentinel);
        seen.push({ ...read, value: undefined });
        h.keys.addActive();
        await store.rekey(identity, s.ref);
        await store.collect();

        const keyForms = [...h.keys.dataKeys.values(), h.keys.operationKey, h.keys.fingerprintKey].flatMap((key) =>
            forms(key)
        );
        const secrets = [...forms(payloadSentinel), ...forms(bodySentinel), ...keyForms];

        const tables = await db.sql<
            { tablename: string }[]
        >`select tablename from pg_tables where schemaname = 'public'`;
        const dumps: string[] = [];
        for (const { tablename } of tables) {
            const rows = await db.sql.unsafe(`select to_jsonb(t)::text as row from "${tablename}" t`);
            dumps.push(rows.map((r) => r.row).join('\n'));
        }
        const surfaces: Array<[string, string]> = [
            ['results and errors', JSON.stringify(seen)],
            ['diagnostics', JSON.stringify(h.diagnostics())],
            ['console', logged.join('\n')],
            ['catalog', dumps.join('\n')],
        ];
        for (const [surface, text] of surfaces) {
            for (const secret of secrets) {
                expect(text.includes(secret), `${surface} leaks ${secret.slice(0, 10)}...`).toBe(false);
            }
        }
        expect(h.diagnostics().length).toBeGreaterThan(0);
    });
});
