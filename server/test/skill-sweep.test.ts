import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import type { ArtifactBackend } from '../src/artifacts/backend.js';
import { startSkillSweep } from '../src/skills/skill-collector.js';

/** The wiring (main.ts passes `config.artifacts.retentionDays`): the sweep's queries carry the value it was given. */
describe('startSkillSweep', () => {
    it('applies the configured retention to every pass', async () => {
        const seen: unknown[][] = [];
        const sql = ((_strings: TemplateStringsArray, ...values: unknown[]) => {
            seen.push(values);
            return Object.assign(Promise.resolve([]), { values });
        }) as unknown as Sql;
        let pass: Promise<unknown> = Promise.resolve();
        const stop = startSkillSweep({
            sql,
            ready: Promise.resolve(),
            artifacts: { objects: {}, prefix: 'p/' } as unknown as ArtifactBackend,
            metrics: { timedPass: (_loop, fn) => (pass = fn()) },
            retentionDays: 90,
            planDefaults: {},
            intervalMs: 3_600_000,
        });
        await vi_waitFor(() => pass);
        await stop();
        expect(seen.flat()).toContain(90);
        expect(seen.flat()).not.toContain(30);
    });
});

/** `timedPass` runs after `ready` resolves, so the first tick needs a few microtasks before `pass` is set. */
async function vi_waitFor(get: () => Promise<unknown>): Promise<void> {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
    await get();
}
