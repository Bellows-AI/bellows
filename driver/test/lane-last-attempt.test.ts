import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { readRepoFile as read } from './fixtures/repo-files.js';

/*
 * The lanes' recovery cases run their job at max_attempts 1 (issue #822), where an expiry spending
 * an attempt would retire it dead. The cap is a psql update neither lane can run here, so these pins
 * are the bytes that keep it checked: `last_attempt` answers non-zero unless the update returned the
 * job's id, and every caller turns that into a check of its own — a cap that did not land fails the
 * case instead of letting it pass without proving the recovery.
 */

const ID = '7b0c6a9e-1f2d-4c3b-9a8e-5d4c3b2a1f0e';

const LANES = [
    {
        script: 'scripts/test-k8s.sh',
        client: 'kubectl',
        callers: [
            ['hard', 'the hard-kill job'],
            ['lost', 'the lost-together job'],
            ['final', 'the finalizing job'],
        ],
    },
    {
        script: 'scripts/test-jobs.sh',
        client: 'compose',
        callers: [
            ['killed', 'the hard-kill job'],
            ['lost', 'the lost-together job'],
        ],
    },
] as const;

/** The script's `last_attempt() {` … `}` definition. */
const lastAttempt = (script: string): string => {
    const start = script.indexOf('\nlast_attempt() {');
    expect(start).toBeGreaterThan(-1);
    return script.slice(start, script.indexOf('\n}\n', start) + 3);
};

/** Runs the script's `last_attempt` against a stub database client that answers `answer` with `status`. */
const run = (lane: (typeof LANES)[number], answer: string, status: number) => {
    const stub = `${lane.client}() { printf '%s\\n' "$ANSWER"; return "$STATUS"; }`;
    return spawnSync('bash', ['-c', `${stub}\n${lastAttempt(read(lane.script))}\nlast_attempt "$1"`, 'bash', ID], {
        encoding: 'utf8',
        input: '',
        timeout: 5000,
        env: { ...process.env, ANSWER: answer, STATUS: String(status) },
    });
};

describe.each(LANES)('$script: the max_attempts 1 cap', (lane) => {
    it('updates the job and returns its id', () => {
        const fn = lastAttempt(read(lane.script));
        expect(fn).toContain('update job set max_attempts = 1 where id =');
        expect(fn).toContain('returning id');
    });

    it('succeeds once the update returned the job', () => {
        expect(run(lane, ID, 0)).toMatchObject({ status: 0, stdout: '' });
    });

    it('fails when the update changed no row', () => {
        expect(run(lane, '', 0)).toMatchObject({ status: 1, stdout: 'no job row changed' });
    });

    it('fails with what psql answered when the update failed', () => {
        const result = run(lane, 'ERROR:  relation "job" does not exist', 3);
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('relation "job" does not exist');
    });

    it('turns every cap into a check of its case', () => {
        const script = read(lane.script);
        for (const [job, name] of lane.callers) {
            expect(script).toContain(`capped="$(last_attempt "$${job}")" && ok '${name} runs at max_attempts 1' ||`);
            expect(script).toContain(`bad '${name} runs at max_attempts 1' "job '$${job}': $capped"`);
        }
        // No unchecked cap is left: the helper is the one update, and every call is a check.
        expect(script.split('update job set max_attempts = 1').length - 1).toBe(1);
        expect(script.split('last_attempt "$').length - 1).toBe(lane.callers.length);
    });
});
