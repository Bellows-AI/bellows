import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { toolTreeReleaseBoundedScript } from '../src/publish.js';

/**
 * The tool tree release on kubernetes runs as the reclaim Job's init container (issue #814): bounded
 * like docker's release, and always 0, so a release that dies or outruns its deadline only leaves the
 * reclaim to find what it finds. The release script is the wrapper's one argument.
 */
const hasTimeout = (): boolean => spawnSync('sh', ['-c', 'command -v timeout'], { stdio: 'ignore' }).status === 0;

const bounded = (release: string, seconds = '5') =>
    spawnSync('sh', ['-c', toolTreeReleaseBoundedScript, 'release', release], {
        env: { ...process.env, RELEASE_DEADLINE_SECONDS: seconds },
        encoding: 'utf8',
        timeout: 20_000,
    });

describe.skipIf(!hasTimeout())('the bounded tool tree release', () => {
    it('passes the release’s tally through and exits 0', () => {
        const ran = bounded('process.stdout.write(JSON.stringify({ released: 2, skipped: 0 }) + "\\n")');
        expect(ran.stdout).toBe('{"released":2,"skipped":0}\n');
        expect(ran.status).toBe(0);
    });

    it('exits 0 when the release itself fails or is killed', () => {
        expect(bounded('process.exit(3)').status).toBe(0);
        expect(bounded('process.kill(process.pid, "SIGKILL")').status).toBe(0);
    });

    it('stops a release that outruns its deadline, and still exits 0', () => {
        const started = Date.now();
        const ran = bounded('setInterval(() => undefined, 1000)', '1');
        expect(ran.status).toBe(0);
        expect(Date.now() - started).toBeLessThan(10_000);
    });
});
