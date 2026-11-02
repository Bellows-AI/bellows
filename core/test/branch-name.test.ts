import { describe, expect, it } from 'vitest';
import { isBranchName } from '../src/branch-name.js';

describe('isBranchName', () => {
    it.each(['main', 'release/1', 'feature/a_b-c.d', 'v1.2.3', '0abc', 'a'.repeat(255)])('accepts %s', (name) => {
        expect(isBranchName(name)).toBe(true);
    });

    it.each(['', '-x', '/x', '.x', 'a..b', 'a b', 'a;b', 'a\nb', 'a$b', 'a'.repeat(256)])('refuses %j', (name) => {
        expect(isBranchName(name)).toBe(false);
    });
});
