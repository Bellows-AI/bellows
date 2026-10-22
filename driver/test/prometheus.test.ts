import { describe, expect, it } from 'vitest';
import { CONTENT_TYPE, createRegistry, timed } from '../src/prometheus.js';

describe('the driver exposition helper', () => {
    it('renders a histogram with cumulative buckets, +Inf, _sum and _count', async () => {
        const registry = createRegistry();
        const h = registry.histogram('d_seconds', 'Durations.', ['verb'], [0.1, 1]);
        h.observe(0.05, { verb: 'get' });
        h.observe(5, { verb: 'get' });
        const text = await registry.render();
        expect(text).toContain('d_seconds_bucket{verb="get",le="0.1"} 1');
        expect(text).toContain('d_seconds_bucket{verb="get",le="1"} 1');
        expect(text).toContain('d_seconds_bucket{verb="get",le="+Inf"} 2');
        expect(text).toContain('d_seconds_count{verb="get"} 2');
        expect(CONTENT_TYPE).toBe('text/plain; version=0.0.4; charset=utf-8');
    });

    it('timed observes once and rethrows', async () => {
        const registry = createRegistry();
        const h = registry.histogram('d_seconds', 'x', [], [1]);
        await expect(
            timed(h, {}, async () => {
                throw new Error('boom');
            })
        ).rejects.toThrow('boom');
        expect(await registry.render()).toContain('d_seconds_count 1');
    });
});
