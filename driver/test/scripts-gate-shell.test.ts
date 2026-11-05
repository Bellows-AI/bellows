import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

    describe('with a mailbox to ask for a GitHub token through', () => {
        const dirs: string[] = [];
        afterEach(() => {
            for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
        });
        const mailbox = () => {
            const dir = mkdtempSync(join(tmpdir(), 'gate-shell-'));
            dirs.push(dir);
            mkdirSync(join(dir, 'run', 'asks'), { recursive: true });
            mkdirSync(join(dir, 'bin'));
            return { run: join(dir, 'run'), bin: join(dir, 'bin') };
        };
        const gateWith = (command: string, env: Record<string, string>) =>
            spawnSync('sh', ['-c', gateShellScript, 'gate', command], {
                encoding: 'utf8',
                env: { PATH: process.env.PATH ?? '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...env },
            });
        const HELPER = 'credential.https://github.com.helper';

        it('puts the helper’s directory first on PATH and resets then sets git’s github.com helper', () => {
            const { run, bin } = mailbox();
            const ran = gateWith(`echo "$PATH"; git config --get-all ${HELPER}`, {
                FACTORY_GATE_RUN: run,
                FACTORY_GATE_BIN: bin,
            });
            const [path, reset, helper, ...rest] = ran.stdout.split('\n');
            expect(path?.startsWith(`${bin}:`)).toBe(true);
            expect(reset).toBe('');
            expect(helper).toBe(`!FACTORY_GATE_MODE=credential /bin/sh '${bin}/gh'`);
            expect(rest).toEqual(['']);
        });

        it('keeps the git config pairs the request env already set, appending its own after them', () => {
            const { run, bin } = mailbox();
            const ran = gateWith(
                'git config --get user.name; git config --get-all ' + HELPER + '; echo "$GIT_CONFIG_COUNT"',
                {
                    FACTORY_GATE_RUN: run,
                    FACTORY_GATE_BIN: bin,
                    GIT_CONFIG_COUNT: '1',
                    GIT_CONFIG_KEY_0: 'user.name',
                    GIT_CONFIG_VALUE_0: 'the gate',
                }
            );
            expect(ran.stdout.split('\n')).toEqual([
                'the gate',
                '',
                `!FACTORY_GATE_MODE=credential /bin/sh '${bin}/gh'`,
                '3',
                '',
            ]);
        });

        it('leaves the environment alone without both variables and the asks directory', () => {
            const { run, bin } = mailbox();
            for (const env of [{}, { FACTORY_GATE_RUN: run }, { FACTORY_GATE_RUN: run, FACTORY_GATE_BIN: '' }]) {
                const ran = gateWith('printenv GIT_CONFIG_COUNT || echo unset; echo "$PATH"', { ...env });
                expect(ran.stdout.split('\n')[0]).toBe('unset');
                expect(ran.stdout).not.toContain(bin);
            }
            const none = gateWith('printenv GIT_CONFIG_COUNT || echo unset', {
                FACTORY_GATE_RUN: join(run, 'missing'),
                FACTORY_GATE_BIN: bin,
            });
            expect(none.stdout).toBe('unset\n');
        });
    });
});
