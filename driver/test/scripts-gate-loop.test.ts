import { describe, expect, it } from 'vitest';
import { gateLoopArgv, gateLoopScript, gateShellScript } from '../src/container-scripts.js';
import { GATE_FILES, MAILBOXES } from '../src/supervisor-contract.js';

/*
 * The gate container's loop (`scripts/gate-loop.sh`), pinned by its bytes ONLY. It is never executed
 * here, nor by hand: after every request and on a cancel it runs `kill -KILL -1`, which in a test
 * process would end every process of the user running the suite — the agent CLI among them. Its
 * behaviour is the kind lane's and test:jobs' to show (scripts/test-k8s.sh, scripts/test-jobs.sh);
 * the supervisor's half of the protocol is played against a JS loop in supervisor.test.ts.
 */

/** The script without its comment lines: what the shell runs. */
const code = gateLoopScript
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

describe('the gate loop script', () => {
    it('is the container command, with the gate shell passed by content beside it', () => {
        expect(gateLoopArgv()).toEqual(['sh', '-c', gateLoopScript, 'gate-loop', gateShellScript]);
    });

    it('serves the gate mailbox the contract names, by the file names the supervisor spells', () => {
        expect(code).toContain(`\${FACTORY_GATE_DIR:-${MAILBOXES.gate.path}}`);
        for (const name of [
            GATE_FILES.requests,
            GATE_FILES.running,
            GATE_FILES.done,
            GATE_FILES.alive,
            GATE_FILES.command,
            GATE_FILES.cwd,
            GATE_FILES.env,
            GATE_FILES.output,
            GATE_FILES.exit,
            GATE_FILES.cancel,
        ]) {
            expect(code, name).toContain(`/${name}`);
        }
    });

    it('kills what a gate left behind before it writes the exit, and kills a cancelled gate', () => {
        const kill = 'kill -KILL -1';
        const cancelBranch = code.slice(code.indexOf('/cancel" ]; then'));
        expect(cancelBranch.slice(0, cancelBranch.indexOf('fi'))).toContain(kill);
        // The last kill of a request comes after its gate ended and before its answer exists, so
        // nothing a gate left running can write into the answer or the next request.
        const exitWrite = code.indexOf('/exit.tmp');
        expect(exitWrite).toBeGreaterThan(-1);
        expect(code.lastIndexOf(kill, exitWrite)).toBeGreaterThan(code.indexOf('wait "$pid"'));
    });

    it('applies a request’s env inside its own subshell, and drops the env file before the command', () => {
        const open = code.indexOf('(\n');
        const close = code.indexOf(') > "$1/output"');
        expect(open).toBeGreaterThan(-1);
        expect(close).toBeGreaterThan(open);
        const subshell = code.slice(open, close);
        expect(code.split('export ').length - 1).toBe(1);
        expect(subshell).toContain('export "$line"');
        expect(subshell.indexOf('/bin/rm -f "$1/env"')).toBeLessThan(subshell.indexOf('exec /bin/sh'));
        expect(subshell).toContain('|| { echo');
        expect(subshell).toContain('exit 126');
    });

    it('runs its own commands by absolute path, so a request’s PATH can never reach them', () => {
        for (const tool of ['mv', 'cat', 'rm', 'sleep', 'mkdir', 'sh']) {
            const bare = new RegExp(`(^|[\\s;|&(])${tool}\\s`, 'm');
            expect(code, tool).not.toMatch(bare);
        }
        expect(code).toContain('/bin/mv');
        expect(code).toContain('exec /bin/sh -c "$shell" gate');
    });

    it('is POSIX: no bashisms, and no process tools the image may lack', () => {
        for (const bashism of ['[[', 'function ', 'local ', "$'", 'source ', '==', '<<<', 'declare ', '${!']) {
            expect(code, bashism).not.toContain(bashism);
        }
        expect(code).not.toMatch(/\b(ps|pkill|pgrep|killall)\b/);
    });
});
