import { describe, expect, it } from 'vitest';
import { gateGithubScript, gateLoopArgv, gateLoopScript, gateShellScript } from '../src/container-scripts.js';
import { GATE_ASK_FILES, GATE_FILES, GATE_REPORT_FILES, MAILBOXES } from '../src/supervisor-contract.js';

/*
 * The gate container's loop (`scripts/gate-loop.sh`), pinned by its bytes. It is never executed here, nor
 * by hand, outside a pid namespace: after a request and on a cancel it runs `kill -KILL -1`, which in a test
 * process would end every process of the user running the suite — the agent CLI among them. It runs in
 * `gate-loop-run.test.ts`, inside `unshare`'s own pid namespace; the supervisor's half of the protocol is
 * played against a JS loop in supervisor.test.ts.
 */

/** The script without its comment lines: what the shell runs. */
const code = gateLoopScript
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

describe('the gate loop script', () => {
    it('is the container command, with the gate shell passed by content beside it', () => {
        expect(gateLoopArgv()).toEqual(['sh', '-c', gateLoopScript, 'gate-loop', gateShellScript, gateGithubScript]);
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

    it('keeps a report directory and the guest samples with each request, by the names the supervisor reads', () => {
        expect(code).toContain(`/bin/mkdir -p "$1/${GATE_REPORT_FILES.dir}"`);
        expect(code).toContain(`>> "$1/${GATE_REPORT_FILES.dir}/${GATE_REPORT_FILES.resources}"`);
        // Sampled at the start, and again before the answer exists, so the answer holds the end of the run.
        const finish = code.slice(code.indexOf('finish() {'), code.indexOf('\n}\n', code.indexOf('finish() {')));
        expect(finish.indexOf('sample "$1"')).toBeGreaterThan(-1);
        expect(finish.indexOf('sample "$1"')).toBeLessThan(finish.indexOf('/exit.tmp'));
        // Builtins and /proc only: a request's PATH never reaches the sampler either.
        expect(code.slice(code.indexOf('sample() {'), code.indexOf('sampler() {'))).not.toMatch(
            /\b(date|awk|sed|grep|cat)\b/
        );
    });

    it('kills what a gate left behind before it writes the exit, and settles a cancelled gate through the same path', () => {
        const sweep = 'kill -KILL -1';
        const finish = code.slice(code.indexOf('finish() {'), code.indexOf('\n}\n', code.indexOf('finish() {')));
        // The last kill of a request comes after its gate ended and before its answer exists, so
        // nothing a gate left running can write into the answer or the next request.
        const exitWrite = finish.indexOf('/exit.tmp');
        expect(exitWrite).toBeGreaterThan(-1);
        expect(finish.lastIndexOf(sweep, exitWrite)).toBeGreaterThan(-1);
        // While another request runs only the finished gate's own process group is killed.
        expect(finish.lastIndexOf('kill -KILL "-$group"', exitWrite)).toBeGreaterThan(-1);
        expect(finish.indexOf('others "$1"')).toBeLessThan(finish.indexOf(sweep));
        // A cancel ends in `finish` as well, once there is a group to kill or nothing else runs.
        const cancelBranch = code.slice(code.indexOf('/cancel" ]'));
        expect(cancelBranch.slice(0, cancelBranch.indexOf('\n        fi'))).toContain('finish "$held"');
    });

    it('serves requests side by side only when setsid exists, and says so in the parallel file', () => {
        expect(code).toContain('/usr/bin/setsid');
        expect(code).toContain(`: > "$box/${GATE_FILES.parallel}"`);
        expect(code).toContain(`/bin/rm -f "$box/${GATE_FILES.parallel}"`);
        // A request is taken beside a running one only with setsid, and only when it and every running one is marked.
        expect(code).toContain('others "" && { [ -z "$setsid" ] || [ ! -e "$request/parallel" ] || ! allparallel; }');
        // Each gate is a session of its own and records its process group where the loop reads it.
        expect(code).toContain('echo $$ > "$FACTORY_GATE_RUN/pgid"');
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

    it('installs the GitHub helper it is handed at bin/gh, and gives each request its mailbox and that bin', () => {
        expect(code).toContain('github=$2');
        expect(code).toContain(`"$box/${GATE_ASK_FILES.bin}"`);
        expect(code).toContain('printf \'%s\\n\' "$github" > "$box/bin/gh"');
        expect(code).toContain('/bin/chmod 0700 "$box/bin/gh"');
        // Given to the gate shell alone, as the assignments of its own `exec`.
        const subshell = code.slice(code.indexOf('start() {'), code.indexOf('\n}\n', code.indexOf('start() {')));
        expect(subshell).toContain('FACTORY_GATE_RUN="$1" FACTORY_GATE_BIN="$box/bin" exec /bin/sh -c "$shell" gate');
        expect(subshell).toContain('FACTORY_GATE_RUN="$1" FACTORY_GATE_BIN="$box/bin" exec "$setsid" /bin/sh -c');
        expect(code.replace(subshell, '')).not.toContain('FACTORY_GATE_RUN');
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
