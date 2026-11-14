import { describe, expect, it } from 'vitest';
import { parseDriverCredentialArgs, runDriverCredentialCommand } from '../src/auth/driver-credential-command.js';
import type { DriverCredentialStore } from '../src/auth/driver-credentials.js';

/** The maintenance command's arguments: a malformed one is a usage error (exit 2) that never reaches the store. */
describe('the driver-credential command line', () => {
    it.each<[string[], unknown]>([
        [['list'], { kind: 'list' }],
        [['issue', '--label', 'east', '--pool'], { kind: 'issue', label: 'east', orgs: null }],
        [['issue', '--label', 'east', '--org', 'a', '--org', 'b'], { kind: 'issue', label: 'east', orgs: ['a', 'b'] }],
        [['revoke', 'id-1'], { kind: 'revoke', id: 'id-1' }],
        [['rotate', 'id-1'], { kind: 'rotate', id: 'id-1', overlapSeconds: 3600 }],
        [['rotate', 'id-1', '--overlap', '0'], { kind: 'rotate', id: 'id-1', overlapSeconds: 0 }],
    ])('reads %j', (argv, parsed) => {
        expect(parseDriverCredentialArgs(argv)).toEqual(parsed);
    });

    it.each([
        [[]],
        [['issue', '--label', 'east']],
        [['issue', '--label', 'east', '--pool', '--org', 'a']],
        [['issue', '--pool']],
        [['issue', '--label', 'x'.repeat(101), '--pool']],
        [['revoke']],
        [['rotate', 'id-1', '--overlap', '-1']],
        [['rotate', 'id-1', '--overlap', '604801']],
        [['rotate', 'id-1', '--window', '5']],
        [['list', 'extra']],
        [['drop', 'id-1']],
    ])('refuses %j as usage, touching no store', async (argv) => {
        const errors: string[] = [];
        const store = new Proxy({} as DriverCredentialStore, {
            get: () => {
                throw new Error('the store was reached');
            },
        });
        const code = await runDriverCredentialCommand(argv, store, { out: () => {}, err: (l) => errors.push(l) });
        expect(code).toBe(2);
        expect(errors.join('\n')).toContain('usage: driver-credential-cli');
    });
});
