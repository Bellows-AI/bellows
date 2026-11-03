import { isBranchName } from '@factory-ai/core';
import { describe, expect, it } from 'vitest';
import { isBranchName as driverRule } from '../../driver/src/publish/publish-base.js';

/** The driver imports nothing, so its branch rule is a copy; this pins it to core's on a fixed table. */
describe('the driver copy of the branch-name rule', () => {
    it.each([
        'main',
        'release/1',
        'feature/a_b-c.d',
        '0abc',
        '',
        '-x',
        '/x',
        '.x',
        'a..b',
        'a b',
        'a;b',
        'a\nb',
        'a$b',
        'a'.repeat(255),
    ])('agrees on %j', (name) => {
        expect(driverRule(name)).toBe(isBranchName(name));
    });
});
