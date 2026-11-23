import { formatRepoRef, githubRepo } from '@factory-ai/core';
import { describe, expect, it } from 'vitest';
import { prLockKey } from '../src/db/jobs/job-store-merge.js';
import { refOfRow } from '../src/db/repo-ref-row.js';

describe('refOfRow', () => {
    it('reads a stored row as its ref', () => {
        expect(refOfRow({ forge: 'gitlab', host: 'gl.example', repo: 'g/sub/p' })).toEqual({
            forge: 'gitlab',
            host: 'gl.example',
            path: 'g/sub/p',
        });
    });

    it.each([
        { forge: 'bitbucket', host: 'github.com', repo: 'o/n' },
        { forge: 'github', host: '', repo: 'o/n' },
        { forge: 'github', host: 'github.com', repo: '' },
        { forge: 'github', host: 'github.com', repo: 'solo' },
    ])('throws on a malformed row %j', (row) => {
        expect(() => refOfRow(row)).toThrow(/not a repository reference/);
    });
});

describe('prLockKey', () => {
    it('is the bare path form for GitHub, so a previous-release pod serializes on the same lock', () => {
        expect(prLockKey('org', githubRepo('O/n'), 7)).toBe('org/O/n/7');
    });

    it('names the forge and host of any other repository', () => {
        const ref = { forge: 'gitlab', host: 'gl.example', path: 'g/sub/p' } as const;
        expect(prLockKey('org', ref, 7)).toBe(`org/${formatRepoRef(ref)}/7`);
        expect(prLockKey('org', ref, 7)).not.toBe(prLockKey('org', githubRepo('g/p'), 7));
    });
});
