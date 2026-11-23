import { describe, expect, it } from 'vitest';
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
