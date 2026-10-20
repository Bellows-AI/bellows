import { describe, expect, it } from 'vitest';
import { reviewLoopArgv, reviewLoopScript } from '../src/container-scripts.js';
import { MAILBOXES, REVIEW_FILES } from '../src/supervisor-contract.js';

/*
 * The reviewer container's loop (`scripts/review-loop.sh`), pinned by its bytes ONLY. It is never
 * executed here, nor by hand: after every request and on a cancel it runs `kill -KILL -1`, which in
 * a test process would end every process of the user running the suite. Its behaviour is the kind
 * lane's and test:jobs' to show; the supervisor's half is commit-sequenced behind it.
 */

/** The script without its comment lines: what the shell runs. */
const code = reviewLoopScript
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

describe('the review loop script', () => {
    it('is the container command', () => {
        expect(reviewLoopArgv()).toEqual(['sh', '-c', reviewLoopScript, 'review-loop']);
    });

    it('serves the review mailbox the contract names, by the file names the contract spells', () => {
        expect(code).toContain(`\${FACTORY_REVIEW_DIR:-${MAILBOXES.review.path}}`);
        for (const name of Object.values(REVIEW_FILES).filter((file) => file !== 'staging')) {
            expect(code, name).toContain(`/${name}`);
        }
    });

    it('kills what a review left behind before it writes the exit, and kills a cancelled review', () => {
        const kill = 'kill -KILL -1';
        const cancelBranch = code.slice(code.indexOf('/cancel" ]; then'));
        expect(cancelBranch.slice(0, cancelBranch.indexOf('fi'))).toContain(kill);
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
        expect(subshell).toContain('exit 126');
    });

    it('runs the request’s command as the executor entrypoint argv, with no gate shell', () => {
        expect(code).toContain('exec /bin/sh -c "$(/bin/cat "$1/command")"');
        expect(code).not.toContain('shell=$1');
    });

    it('runs its own commands by absolute path, so a request’s PATH can never reach them', () => {
        for (const tool of ['mv', 'cat', 'rm', 'sleep', 'mkdir', 'sh']) {
            const bare = new RegExp(`(^|[\\s;|&(])${tool}\\s`, 'm');
            expect(code, tool).not.toMatch(bare);
        }
    });

    it('resumes a restart by marking what it held as done with no exit, and beats while it waits', () => {
        expect(code).toContain('"$box/running"/*');
        expect(code).toContain('/bin/mv "$held" "$box/done/"');
        expect(code).toContain(': > "$box/alive"');
    });

    it('is POSIX: no bashisms, and no process tools the image may lack', () => {
        for (const bashism of ['[[', 'function ', 'local ', "$'", 'source ', '==', '<<<', 'declare ', '${!']) {
            expect(code, bashism).not.toContain(bashism);
        }
        expect(code).not.toMatch(/\b(ps|pkill|pgrep|killall)\b/);
    });
});
