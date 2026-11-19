import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';

// Fixture jobs carry constant ids, and the runner derives its env file's path from them: forks
// sharing one temp directory unlinked each other's file mid-run (`vitest.tmpdir.ts`).
describe('the worker temp directory', () => {
    it('is a directory of this worker process, not the shared one', () => {
        expect(basename(tmpdir())).toMatch(/^vitest-worker-/);
        expect(existsSync(tmpdir())).toBe(true);
        expect(process.env.TMPDIR).toBe(tmpdir());
    });
});
