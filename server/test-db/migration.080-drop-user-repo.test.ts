import { describe, expect, it } from 'vitest';
import { useTestDb } from './harness.js';

/** Issue #777: the per-member checkout table is gone once the migrations have run. */
const enabled = Boolean(process.env.DATABASE_URL);
const db = useTestDb();

describe.skipIf(!enabled)('080_drop_user_repo', () => {
    it('leaves no user_repo table after migrate', async () => {
        const [row] = await db.sql<{ t: string | null }[]>`select to_regclass('user_repo')::text as t`;
        expect(row?.t).toBeNull();
    });
});
