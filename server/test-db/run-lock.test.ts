import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { acquireRunLock } from './run-lock.js';

const url = process.env.DATABASE_URL;

// The lock key is the name, so a name minted here never contends with the run's own lock.
describe.skipIf(!url)('run lock', () => {
    it('refuses a second holder of the same database name, naming it, until the first lets go', async () => {
        const name = `lock_${randomUUID().replaceAll('-', '')}_test`;
        const first = await acquireRunLock(url as string, name);
        await expect(acquireRunLock(url as string, name)).rejects.toThrow(
            `test database ${name} is in use by another run`
        );
        await first.release();
        const again = await acquireRunLock(url as string, name);
        await again.release();
    });

    it('lets two different databases run side by side', async () => {
        const a = await acquireRunLock(url as string, `lock_${randomUUID().replaceAll('-', '')}_test`);
        const b = await acquireRunLock(url as string, `lock_${randomUUID().replaceAll('-', '')}_test`);
        await a.release();
        await b.release();
    });
});
