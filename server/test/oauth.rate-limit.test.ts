import { describe, expect, it } from 'vitest';
import { addressKey, createRateLimiter } from '../src/oauth/rate-limit.js';

describe('addressKey', () => {
    it('keeps an IPv4 address whole and keys an IPv6 address by its /64', () => {
        expect(addressKey('203.0.113.7')).toBe('203.0.113.7');
        expect(addressKey('2001:db8:1:2::1')).toBe(addressKey('2001:db8:1:2:ffff:0:0:9'));
        expect(addressKey('2001:db8:1:2::1')).not.toBe(addressKey('2001:db8:1:3::1'));
        expect(addressKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    });
});

describe('the rate limiter table', () => {
    it('never holds more keys than its bound, however many callers sweep it', () => {
        const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 4 });
        for (let i = 0; i < 50; i += 1) limiter.hit(`caller-${i}`);
        expect(limiter.size()).toBeLessThanOrEqual(4);
    });

    it('drops expired windows first, so a live caller keeps its count', () => {
        let at = 0;
        const limiter = createRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 3, now: () => at });
        limiter.hit('old-1');
        limiter.hit('old-2');
        at = 500;
        limiter.hit('live');
        at = 1200;
        limiter.hit('new');
        expect(limiter.hit('live')).toMatchObject({ ok: false });
    });
});
