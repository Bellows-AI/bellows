import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Fixture jobs carry constant ids, and the runner derives its env file's path from them: forks
// sharing one temp directory unlinked each other's file mid-run (`vitest.tmpdir.ts`).
describe('the worker temp directory', () => {
    it('is a directory of this worker process, not the shared one', () => {
        expect(basename(tmpdir())).toMatch(/^vitest-worker-/);
        expect(existsSync(tmpdir())).toBe(true);
        expect(process.env.TMPDIR).toBe(tmpdir());
    });

    // A unix socket path holds 103 bytes on macOS. macOS's own TMPDIR is already ~50 bytes, so the
    // worker directory must hang off a short base for the longest socket the driver suites bind
    // (`entrypoint-helper-race.test.ts`) to fit.
    it('leaves room for the longest socket path the driver suites bind', () => {
        const socket = join(tmpdir(), 'entrypoint-race-claude-XXXXXX', 'out', 'control.sock');
        expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(103);
    });
});
