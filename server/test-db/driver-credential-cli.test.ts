import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { runDriverCredentialCommand } from '../src/auth/driver-credential-command.js';
import { createDriverCredentialStore } from '../src/auth/driver-credentials.js';
import { testOrg } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * The maintenance command against the database: a self-hosted deployment, which has no operator account, issues,
 * rotates and revokes its drivers' credentials with it. A minted token is printed once, on its own line.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const db = useTestDb();

async function run(argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const store = createDriverCredentialStore({ sql: db.sql });
    const code = await runDriverCredentialCommand(argv, store, { out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out, err, store };
}

describe.skipIf(!enabled)('driver-credential-cli', () => {
    it('issues a pool credential, prints its token once, and the token resolves to the pool', async () => {
        const { code, out, store } = await run(['issue', '--label', 'self-hosted', '--pool']);
        expect(code).toBe(0);
        const [listed, token] = out;
        expect(JSON.parse(listed!)).toMatchObject({ label: 'self-hosted', pool: true, createdBy: null });
        expect(token).toMatch(/^drv_[0-9a-f]{64}$/);
        expect(await store.resolve(token!)).toMatchObject({ orgs: null });
        expect((await run(['list'])).out.join('\n')).not.toContain(token);
    });

    it('rotates with an overlap, then revokes: the old token works inside the window, nothing after a revoke', async () => {
        const issued = await run(['issue', '--label', 'east', '--pool']);
        const id = (JSON.parse(issued.out[0]!) as { id: string }).id;
        const old = issued.out[1]!;

        const rotated = await run(['rotate', id, '--overlap', '600']);
        expect(rotated.code).toBe(0);
        const fresh = rotated.out[1]!;
        expect(await rotated.store.resolve(old)).not.toBeNull();
        expect(await rotated.store.resolve(fresh)).not.toBeNull();
        expect((await run(['rotate', id])).code).toBe(1);

        const successor = (JSON.parse(rotated.out[0]!) as { id: string }).id;
        const revoked = await run(['revoke', successor]);
        expect(revoked.code).toBe(0);
        expect(await revoked.store.resolve(fresh)).toBeNull();
    });

    it('refuses an unknown organization or id with exit 1', async () => {
        expect((await run(['issue', '--label', 'x', '--org', testOrg()])).code).toBe(1);
        expect((await run(['revoke', randomUUID()])).code).toBe(1);
        expect((await run(['rotate', 'not-a-uuid'])).code).toBe(1);
    });
});
