import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * scripts/lane-hosts.cjs lets a lane's host process resolve `host.docker.internal`, a name docker gives containers only:
 * the gitlab phase's board names its TLS fake that way, as the runners do.
 */
const ROOT = new URL('../..', import.meta.url).pathname;
const PRELOAD = join(ROOT, 'scripts/lane-hosts.cjs');

const resolve = (hosts: string, script: string): string =>
    execFileSync(process.execPath, ['--require', PRELOAD, '-e', script], {
        env: { PATH: process.env.PATH, LANE_HOSTS: hosts },
        encoding: 'utf8',
    });

describe('lane-hosts preload', () => {
    it('answers a named host from dns.lookup, one address and all of them', () => {
        const out = resolve(
            'lane.docker.internal=10.9.8.7',
            `const dns = require('node:dns');
             dns.lookup('lane.docker.internal', (e, a, f) => {
                 dns.lookup('lane.docker.internal', { all: true }, (e2, list) => console.log(JSON.stringify([a, f, list])));
             });`
        );
        expect(JSON.parse(out)).toEqual(['10.9.8.7', 4, [{ address: '10.9.8.7', family: 4 }]]);
    });

    it('leaves every other name to the resolver', () => {
        const out = resolve(
            'lane.docker.internal=10.9.8.7',
            `require('node:dns').lookup('localhost', (e, a) => console.log(e ? 'error' : a));`
        );
        expect(out.trim()).toMatch(/^(127\.0\.0\.1|::1)$/);
    });
});
