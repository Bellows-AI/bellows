import { describe, expect, it } from 'vitest';
import type { PublishStep } from '../src/publish.js';
import { pushWithLease } from '../src/publish-stale.js';

const BRANCH = 'factory/a457474a-0191-492d-8cda-d52679466966';
const REMOTE_SHA = '2c99ed1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const STALE = 'rejected HEAD -> factory/x (stale info)';
const PUSH: PublishStep = { label: 'git push', entrypoint: 'git', args: ['push'], env: true, inRepo: true };

/** The commit the publish validated and records: HEAD, unless a test says something moved it. */
const SHA = 'a'.repeat(40);
const LEASE = { branch: BRANCH, credentialHelper: 'helper', sha: SHA };

/**
 * A scripted transport: `push` answers the pushes in order, `behind` answers the rev-list count,
 * `head` what HEAD reads after the fetch (default: SHA).
 */
const transport = (opts: { pushes: (string | null)[]; behind?: string; head?: string }) => {
    const labels: string[] = [];
    const pushes = [...opts.pushes];
    const run = async (s: PublishStep): Promise<{ stdout: string }> => {
        labels.push(s.label);
        if (s.label === 'git push') {
            const failure = pushes.shift();
            if (failure) throw new Error(failure);
        }
        if (s.label === 'git rev-parse HEAD') return { stdout: `${opts.head ?? SHA}\n` };
        if (s.label === 'git rev-parse') return { stdout: `${REMOTE_SHA}\n` };
        if (s.label === 'git rev-list') return { stdout: `${opts.behind ?? '0'}\n` };
        return { stdout: '' };
    };
    return { run, labels };
};

describe('pushWithLease (issue #500)', () => {
    it('pushes once when the lease holds', async () => {
        const t = transport({ pushes: [null] });
        await pushWithLease(t.run, PUSH, LEASE);
        expect(t.labels).toEqual(['git push']);
    });

    it('refreshes the tracking ref and retries when HEAD already contains the remote head', async () => {
        const t = transport({ pushes: [STALE, null], behind: '0' });
        await pushWithLease(t.run, PUSH, LEASE);
        expect(t.labels).toEqual([
            'git push',
            'git fetch',
            'git rev-parse HEAD',
            'git rev-parse',
            'git rev-list',
            'git push',
        ]);
    });

    // Issue #825: the recovery fetch runs the repository's hooks; a HEAD it moved is not the commit
    // the publish validated, and is never the one the retry pushes.
    it('refuses the retry, without a second push, when HEAD moved during the recovery fetch', async () => {
        const t = transport({ pushes: [STALE, null], head: 'b'.repeat(40) });
        await expect(pushWithLease(t.run, PUSH, LEASE)).rejects.toThrow(
            new RegExp(`HEAD moved from ${SHA} to ${'b'.repeat(40)}`)
        );
        expect(t.labels).toEqual(['git push', 'git fetch', 'git rev-parse HEAD']);
    });

    it('fails naming the remote SHA, without a second push, when the remote has commits HEAD lacks', async () => {
        const t = transport({ pushes: [STALE], behind: '2' });
        await expect(pushWithLease(t.run, PUSH, LEASE)).rejects.toThrow(
            new RegExp(`origin/${BRANCH} moved to ${REMOTE_SHA} outside the runner`)
        );
        expect(t.labels).toEqual(['git push', 'git fetch', 'git rev-parse HEAD', 'git rev-parse', 'git rev-list']);
    });

    it('rethrows any other push failure untouched', async () => {
        const t = transport({ pushes: ['remote: Permission denied'] });
        await expect(pushWithLease(t.run, PUSH, LEASE)).rejects.toThrow('Permission denied');
        expect(t.labels).toEqual(['git push']);
    });
});
