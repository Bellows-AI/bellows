import { describe, expect, it } from 'vitest';
import { parseRotateArgs } from '../src/secrets/rotate-args.js';

describe('parseRotateArgs', () => {
    it('defaults to a rotation pass', () => {
        expect(parseRotateArgs([])).toEqual({ mode: 'rotate', batchSize: undefined });
    });

    it('takes a batch size', () => {
        expect(parseRotateArgs(['--batch', '25'])).toEqual({ mode: 'rotate', batchSize: 25 });
    });

    it('takes a key id to verify as retired', () => {
        expect(parseRotateArgs(['--verify-retired', 'k1'])).toEqual({ mode: 'verify-retired', keyId: 'k1' });
    });

    it.each([
        [['--batch']],
        [['--batch', '0']],
        [['--batch', 'x']],
        [['--verify-retired']],
        [['--verify-retired', 'k1', '--batch', '5']],
        [['--unknown']],
    ])('refuses %j as usage', (argv) => {
        expect(parseRotateArgs(argv)).toEqual({ mode: 'usage', message: expect.any(String) });
    });
});
