import { afterEach, describe, expect, it } from 'vitest';
import { killLiveChildren, runAsync } from './fixtures/run-async.js';

afterEach(killLiveChildren);

describe('killLiveChildren', () => {
    it('ends a child whose backgrounded descendant holds the pipes open', async () => {
        const running = runAsync('sh', ['-c', 'sleep 60 & wait']);
        await new Promise((resolve) => setTimeout(resolve, 200));
        const bound = new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 3_000));
        const outcome = await Promise.race([killLiveChildren().then(() => 'killed' as const), bound]);
        expect(outcome).toBe('killed');
        expect((await running).status).toBeNull();
    });
});
