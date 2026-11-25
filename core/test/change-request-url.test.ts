import { describe, expect, it } from 'vitest';
import { formatChangeRequestUrl, parseChangeRequestUrl } from '../src/change-request-url.js';
import { ACCEPTED, gh, gl, INVALID_NUMBERS, REJECTED } from './change-request-url.fixtures.js';

describe('parseChangeRequestUrl', () => {
    it.each(ACCEPTED)('reads %s', (text, expected) => {
        expect(parseChangeRequestUrl(text)).toEqual(expected);
    });

    it.each(REJECTED)('refuses %j', (text) => {
        expect(parseChangeRequestUrl(text)).toBeNull();
    });
});

describe('formatChangeRequestUrl', () => {
    it('writes each forge its own path shape', () => {
        expect(formatChangeRequestUrl(gh('acme/web', 7).ref as never, 7)).toBe('https://github.com/acme/web/pull/7');
        expect(formatChangeRequestUrl(gl('g/sub/p', 5, 'gl.example:8443').ref as never, 5)).toBe(
            'https://gl.example:8443/g/sub/p/-/merge_requests/5'
        );
    });

    it('round-trips what the parser accepts', () => {
        for (const [, parsed] of ACCEPTED) {
            const url = formatChangeRequestUrl(parsed.ref as never, parsed.number);
            expect(parseChangeRequestUrl(url)).toEqual(parsed);
        }
    });

    it.each(INVALID_NUMBERS)('refuses the number %s', (number) => {
        expect(() => formatChangeRequestUrl(gh('acme/web', 1).ref as never, number)).toThrow(RangeError);
    });

    it('writes the INT4 maximum', () => {
        expect(formatChangeRequestUrl(gh('acme/web', 1).ref as never, 2147483647)).toBe(
            'https://github.com/acme/web/pull/2147483647'
        );
    });
});
