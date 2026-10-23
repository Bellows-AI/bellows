import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONTENT_TYPE, createRegistry, timed } from '../src/prometheus.js';

describe('prometheus exposition', () => {
    it('renders a counter with HELP, TYPE and escaped label values, sorted deterministically', async () => {
        const registry = createRegistry();
        const c = registry.counter('t_total', 'Things\nand "stuff" \\ here.', ['kind']);
        c.inc({ kind: 'b' });
        c.inc({ kind: 'a"\\\n' }, 2);
        c.inc({ kind: 'b' });
        const text = await registry.render();
        expect(text).toBe(
            [
                '# HELP t_total Things\\nand "stuff" \\\\ here.',
                '# TYPE t_total counter',
                't_total{kind="a\\"\\\\\\n"} 2',
                't_total{kind="b"} 2',
                '',
            ].join('\n')
        );
    });

    it('renders a histogram with cumulative buckets ending +Inf, _sum and _count', async () => {
        const registry = createRegistry();
        const h = registry.histogram('t_seconds', 'Durations.', ['route'], [0.1, 1]);
        h.observe(0.05, { route: '/a' });
        h.observe(0.5, { route: '/a' });
        h.observe(7, { route: '/a' });
        const text = await registry.render();
        expect(text).toContain('# TYPE t_seconds histogram');
        expect(text).toContain('t_seconds_bucket{route="/a",le="0.1"} 1');
        expect(text).toContain('t_seconds_bucket{route="/a",le="1"} 2');
        expect(text).toContain('t_seconds_bucket{route="/a",le="+Inf"} 3');
        expect(text).toContain('t_seconds_sum{route="/a"} 7.55');
        expect(text).toContain('t_seconds_count{route="/a"} 3');
    });

    it('rejects a label set that does not match the declared names', () => {
        const registry = createRegistry();
        const c = registry.counter('t_total', 'x', ['kind']);
        expect(() => c.inc({ other: 'x' })).toThrow(/labels/);
        expect(() => c.inc()).toThrow(/labels/);
    });

    it('renders gauges read per scrape and omits a failed read, counting the failure', async () => {
        const registry = createRegistry({ failures: 'x_read_failures_total' });
        let fail = false;
        registry.collect('occupancy', async () => {
            if (fail) throw new Error('timeout');
            return [{ name: 'x_running', help: 'Running.', samples: [{ labels: { scope: 'global' }, value: 3 }] }];
        });
        expect(await registry.render()).toContain('x_running{scope="global"} 3');
        fail = true;
        const text = await registry.render();
        expect(text).not.toContain('x_running{');
        expect(text).toContain('x_read_failures_total{source="occupancy"} 1');
    });

    it('bounds a scrape-time read that never returns: omits it, aborts its signal, counts the failure', async () => {
        const registry = createRegistry({ failures: 'x_read_failures_total', readDeadlineMs: 20 });
        let seen: AbortSignal | undefined;
        registry.collect('stuck', (signal) => {
            seen = signal;
            return new Promise(() => undefined);
        });
        const text = await registry.render();
        expect(text).toContain('x_read_failures_total{source="stuck"} 1');
        expect(seen?.aborted).toBe(true);
    });

    it('timed observes exactly once on success and on failure, and rethrows', async () => {
        const registry = createRegistry();
        const h = registry.histogram('t_seconds', 'x', ['outcome'], [1]);
        await expect(
            timed(
                h,
                (outcome) => ({ outcome }),
                async () => 'v'
            )
        ).resolves.toBe('v');
        await expect(
            timed(
                h,
                (outcome) => ({ outcome }),
                async () => {
                    throw new Error('boom');
                }
            )
        ).rejects.toThrow('boom');
        const text = await registry.render();
        expect(text).toContain('t_seconds_count{outcome="ok"} 1');
        expect(text).toContain('t_seconds_count{outcome="error"} 1');
    });

    it('timed takes plain labels too', async () => {
        const registry = createRegistry();
        const h = registry.histogram('t_seconds', 'x', ['kind'], [1]);
        await timed(h, { kind: 'a' }, async () => undefined);
        expect(await registry.render()).toContain('t_seconds_count{kind="a"} 1');
    });

    it('exposes the 0.0.4 text content type', () => {
        expect(CONTENT_TYPE).toBe('text/plain; version=0.0.4; charset=utf-8');
    });

    it('is the same file as the driver copy (the driver imports nothing from the server)', () => {
        const server = readFileSync(new URL('../src/prometheus.ts', import.meta.url), 'utf8');
        const driver = readFileSync(new URL('../../driver/src/prometheus.ts', import.meta.url), 'utf8');
        expect(driver).toBe(server);
    });
});
