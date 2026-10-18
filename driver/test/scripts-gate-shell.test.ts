import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { gateShellScript } from '../src/container-scripts.js';

/**
 * Issue #814: the agent's tools run as their own uid in group 1000, so a gate writes the tree it
 * shares with them group-writable. The command is the script's one argument — never interpolated.
 */
const gate = (command: string) => spawnSync('sh', ['-c', gateShellScript, 'gate', command], { encoding: 'utf8' });

describe('the gate shell', () => {
    it('runs the command under umask 002', () => {
        expect(gate('umask').stdout.trim()).toBe('0002');
    });

    it('runs the command as one shell line and answers its exit status', () => {
        const ran = gate('echo "a b" && exit 7');
        expect(ran.stdout).toBe('a b\n');
        expect(ran.status).toBe(7);
    });

    it('never splits or re-expands the command it is handed', () => {
        expect(gate('printf %s "$1"').stdout).toBe('');
        expect(gate("echo '$(id -u)'").stdout).toBe('$(id -u)\n');
    });
});
