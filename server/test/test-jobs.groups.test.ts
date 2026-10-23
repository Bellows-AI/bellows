import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const GROUPS = join(ROOT, 'scripts/test-jobs-groups.mjs');

interface Slot {
    groups: { name: string; phases: string[] }[];
    seconds: number;
}
interface Module {
    GROUPS: { name: string; phases: string[] }[];
    plan: (selected: string[] | null, slots: number) => Slot[];
}
const load = async (): Promise<Module> => (await import(GROUPS)) as Module;
const phasesOf = async (): Promise<string[]> =>
    ((await import(join(ROOT, 'scripts/test-jobs-changed.mjs'))) as { PHASES: string[] }).PHASES;

describe('test-jobs --parallel groups (#887)', () => {
    it('partition the lane: every phase is in exactly one group', async () => {
        const { GROUPS: groups } = await load();
        const listed = groups.flatMap((group) => group.phases);
        expect([...listed].sort()).toEqual([...(await phasesOf())].sort());
    });

    it('deal every selected phase to exactly one slot, and never more slots than asked', async () => {
        const { plan } = await load();
        for (const slots of [2, 3, 4]) {
            const dealt = plan(null, slots);
            expect(dealt.length).toBeLessThanOrEqual(slots);
            expect(dealt.flatMap((slot) => slot.groups.flatMap((group) => group.phases)).sort()).toEqual(
                [...(await phasesOf())].sort()
            );
        }
    });

    it('keep a hand-picked selection whole, dropping groups with nothing selected', async () => {
        const { plan } = await load();
        const dealt = plan(['board', 'tool-isolation'], 2);
        expect(dealt.flatMap((slot) => slot.groups)).toEqual(
            expect.arrayContaining([
                { name: 'core', phases: ['board'] },
                { name: 'cli-stop', phases: ['tool-isolation'] },
            ])
        );
        expect(dealt.flatMap((slot) => slot.groups)).toHaveLength(2);
    });

    it('balance the slots: the heaviest slot is under three quarters of the serial total', async () => {
        const { plan } = await load();
        const dealt = plan(null, 2);
        const total = dealt.reduce((sum, slot) => sum + slot.seconds, 0);
        expect(Math.max(...dealt.map((slot) => slot.seconds))).toBeLessThan(total * 0.75);
    });

    it('refuse an unknown phase', async () => {
        const { plan } = await load();
        expect(() => plan(['nope'], 2)).toThrow('unknown phase: nope');
    });

    it('print one slot, group and phase list per line from the command line', () => {
        const out = spawnSync('node', [GROUPS, '2', 'board,auth,tool-isolation'], { encoding: 'utf8' });
        expect(out.status).toBe(0);
        const lines = out.stdout
            .trim()
            .split('\n')
            .map((line) => line.split('\t'));
        expect(lines.map(([, name, phases]) => `${name}=${phases}`).sort()).toEqual([
            'cli-stop=tool-isolation',
            'core=board,auth',
        ]);
        expect(spawnSync('node', [GROUPS, '0', 'all'], { encoding: 'utf8' }).status).toBe(2);
    });
});
