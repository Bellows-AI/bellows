import { formatRepoRef, parseRepoRef } from '@factory-ai/core';
import { describe, expect, it } from 'vitest';
import { cloneHostRefusal, formatRepoRef as driverFormat, isRepoRef } from '../../driver/src/repo-ref.js';

/** The driver imports nothing, so its repo ref is a copy; this pins it to core's. */
const WELL_FORMED = ['acme/web', 'github:github.com/o/n', 'gitlab:gl.example/g/sub/p', 'gitlab:gl.example:8443/g/p'];
const MALFORMED = [
    { forge: 'gitlab', host: 'a/b', path: 'g/p' },
    { forge: 'svn', host: 'h', path: 'g/p' },
    { forge: 'gitlab', host: 'gl.example', path: 'p' },
    { forge: 'gitlab', host: '', path: 'g/p' },
    { forge: 'github', host: 'github.com', path: 'o/n/x' },
    { forge: 'gitlab', host: '..', path: 'o/n' },
    { forge: 'gitlab', host: '.', path: 'o/n' },
    { forge: 'gitlab', host: '..:80', path: 'o/n' },
    'o/n',
    null,
];

describe('the driver copy of the repo ref', () => {
    it.each(WELL_FORMED)("isRepoRef agrees with core's parse of %s", (text) => {
        const ref = parseRepoRef(text)!;
        expect(isRepoRef(ref)).toBe(true);
        expect(driverFormat(ref)).toBe(formatRepoRef(ref));
    });

    it.each(MALFORMED)('isRepoRef refuses %j', (value) => {
        expect(isRepoRef(value)).toBe(false);
    });

    it('cloneHostRefusal refuses every host but github.com', () => {
        expect(cloneHostRefusal({ forge: 'github', host: 'github.com', path: 'o/n' })).toBeNull();
        expect(cloneHostRefusal({ forge: 'github', host: 'GitHub.com', path: 'o/n' })).toBeNull();
        expect(cloneHostRefusal({ forge: 'gitlab', host: 'gl.example', path: 'g/sub/p' })).toContain(
            'gitlab:gl.example/g/sub/p'
        );
        expect(cloneHostRefusal({ forge: 'github', host: 'ghe.example', path: 'o/n' })).toContain('ghe.example');
    });
});
