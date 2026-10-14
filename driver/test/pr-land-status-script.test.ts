import { execFile as execFileCb } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The pr-land skill's helper (issue #729), run under /bin/sh (dash on CI, as in the runner images)
 * against a stub `gh` on PATH. The stub answers from canned JSON and applies the script's own
 * `--jq` filter with a real jq, so the filters are exercised, not echoed back.
 */
const execFile = promisify(execFileCb);
const SCRIPT = join(fileURLToPath(import.meta.url), '..', '..', '..', 'docker', 'skills', 'pr-land', 'pr-status.sh');

const FAKE_GH = `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync, existsSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
appendFileSync(process.env.GH_CALLS, JSON.stringify(args) + '\\n');
const jqAt = args.indexOf('--jq');
const answer = (json, code = 0) => {
    process.stdout.write(execFileSync('jq', ['-r', args[jqAt + 1]], { input: JSON.stringify(json) }));
    process.exit(code);
};
const [group, verb] = args;
if (group === 'pr' && verb === 'view') answer(JSON.parse(process.env.GH_PR_VIEW));
if (group === 'pr' && verb === 'checks') {
    if (process.env.GH_CHECKS_ERR) {
        process.stderr.write(process.env.GH_CHECKS_ERR + '\\n');
        process.exit(1);
    }
    const counter = process.env.GH_CALLS + '.checks';
    const n = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
    writeFileSync(counter, String(n + 1));
    const sequence = JSON.parse(process.env.GH_CHECKS);
    const checks = sequence[Math.min(n, sequence.length - 1)];
    if (checks === null) {
        process.stderr.write("no checks reported on the 'fix/x' branch\\n");
        process.exit(1);
    }
    const code = checks.some((c) => c.bucket === 'pending') ? 8 : checks.some((c) => c.bucket === 'fail') ? 1 : 0;
    answer(checks, code);
}
if (group === 'api' && verb === 'graphql') answer(JSON.parse(process.env.GH_THREADS));
process.stderr.write('stub gh: unexpected call ' + args.join(' ') + '\\n');
process.exit(3);
`;

interface Check {
    bucket: string;
    name: string;
    link: string;
}

interface Thread {
    isResolved: boolean;
    comments: { nodes: { author: { login: string } | null }[] };
}

const thread = (isResolved: boolean, lastAuthor: string | null): Thread => ({
    isResolved,
    comments: { nodes: [{ author: lastAuthor === null ? null : { login: lastAuthor } }] },
});

interface Stub {
    view?: object;
    /** One answer per `gh pr checks` call, the last repeating; null is "no checks reported". */
    checks?: (Check[] | null)[];
    checksErr?: string;
    threads?: Thread[];
}

const tempDirs: string[] = [];
afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const pass = (name: string): Check => ({ bucket: 'pass', name, link: `https://ci.example/${name}` });
const fail = (name: string): Check => ({ bucket: 'fail', name, link: `https://ci.example/${name}` });
const pending = (name: string): Check => ({ bucket: 'pending', name, link: `https://ci.example/${name}` });

const VIEW = { number: 42, state: 'OPEN', headRefOid: 'abc123', reviewDecision: '' };

async function run(
    args: string[],
    stub: Stub = {}
): Promise<{ code: number; stdout: string; stderr: string; calls: string[][] }> {
    const dir = mkdtempSync(join(tmpdir(), 'pr-land-'));
    tempDirs.push(dir);
    writeFileSync(join(dir, 'gh'), FAKE_GH);
    chmodSync(join(dir, 'gh'), 0o755);
    const calls = join(dir, 'calls.log');
    writeFileSync(calls, '');
    const env: NodeJS.ProcessEnv = {
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        GH_CALLS: calls,
        GH_PR_VIEW: JSON.stringify(stub.view ?? VIEW),
        GH_CHECKS: JSON.stringify(stub.checks ?? [[pass('test')]]),
        GH_THREADS: JSON.stringify({
            data: {
                viewer: { login: 'factory-agent' },
                repository: { pullRequest: { reviewThreads: { nodes: stub.threads ?? [] } } },
            },
        }),
    };
    if (stub.checksErr) env.GH_CHECKS_ERR = stub.checksErr;
    let code = 0;
    let stdout = '';
    let stderr = '';
    try {
        ({ stdout, stderr } = await execFile('/bin/sh', [SCRIPT, ...args], { env }));
    } catch (error) {
        const failed = error as { code: number; stdout: string; stderr: string };
        ({ code, stdout, stderr } = failed);
    }
    const lines = readFileSync(calls, 'utf8').split('\n').filter(Boolean);
    return { code, stdout, stderr, calls: lines.map((line) => JSON.parse(line) as string[]) };
}

describe('pr-land pr-status.sh', () => {
    it('reports ci=green with the PR facts when every check passes and no thread is open', async () => {
        const result = await run(['42'], { checks: [[pass('test'), pass('lint')]] });
        expect(result.code).toBe(0);
        expect(result.stdout).toBe(
            'pr=42\nstate=OPEN\nhead=abc123\nreview_decision=NONE\nci=green\nunanswered_threads=0\n'
        );
    });

    it('reports ci=red and one failing line per failed check, with its link', async () => {
        const result = await run(['42'], { checks: [[pass('test'), fail('lint js'), fail('build')]] });
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('ci=red\n');
        expect(result.stdout).toContain('failing=lint js https://ci.example/lint js\n');
        expect(result.stdout).toContain('failing=build https://ci.example/build\n');
    });

    it('counts a cancelled check as failing, never as green', async () => {
        const result = await run(['42'], {
            checks: [[pass('test'), { bucket: 'cancel', name: 'lint', link: 'https://ci.example/lint' }]],
        });
        expect(result.stdout).toContain('ci=red\n');
        expect(result.stdout).toContain('failing=lint https://ci.example/lint\n');
    });

    it('waits until the checks settle, then reports their verdict', async () => {
        const result = await run(['42', '--interval', '0'], {
            checks: [[pending('test')], [pending('test')], [pass('test')]],
        });
        expect(result.stdout).toContain('ci=green\n');
        expect(result.calls.filter(([group, verb]) => group === 'pr' && verb === 'checks')).toHaveLength(3);
    });

    it('takes one sample and reports ci=pending under --no-wait', async () => {
        const result = await run(['42', '--no-wait'], { checks: [[pending('test')], [pass('test')]] });
        expect(result.stdout).toContain('ci=pending\n');
        expect(result.calls.filter(([group, verb]) => group === 'pr' && verb === 'checks')).toHaveLength(1);
    });

    it('stops waiting at --timeout and reports ci=pending', async () => {
        const result = await run(['42', '--timeout', '1', '--interval', '1'], { checks: [[pending('test')]] });
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('ci=pending\n');
    });

    it('keeps polling a just-pushed head that reports no checks yet', async () => {
        const result = await run(['42', '--interval', '0'], { checks: [null, null, [pass('test')]] });
        expect(result.stdout).toContain('ci=green\n');
        expect(result.calls.filter(([group, verb]) => group === 'pr' && verb === 'checks')).toHaveLength(3);
    });

    it('reports ci=none when no check is reported for the whole wait', async () => {
        const result = await run(['42', '--timeout', '1', '--interval', '1'], { checks: [null] });
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('ci=none\n');
    });

    it('reports ci=none from one sample under --no-wait', async () => {
        const result = await run(['42', '--no-wait'], { checks: [null, [pass('test')]] });
        expect(result.stdout).toContain('ci=none\n');
        expect(result.calls.filter(([group, verb]) => group === 'pr' && verb === 'checks')).toHaveLength(1);
    });

    it('exits 2 naming the gh error when gh pr checks fails for another reason', async () => {
        const result = await run(['42'], { checksErr: 'HTTP 401: Bad credentials' });
        expect(result.code).toBe(2);
        expect(result.stderr).toContain('HTTP 401: Bad credentials');
        expect(result.stdout).toBe('');
    });

    it('counts unresolved threads whose last word is not ours, and passes the decision through', async () => {
        const result = await run(['42'], {
            view: { ...VIEW, reviewDecision: 'CHANGES_REQUESTED' },
            threads: [
                thread(false, 'reviewer'),
                thread(false, 'factory-agent'),
                thread(true, 'reviewer'),
                thread(false, null),
            ],
        });
        expect(result.stdout).toContain('review_decision=CHANGES_REQUESTED\n');
        expect(result.stdout).toContain('unanswered_threads=2\n');
    });

    it('resolves a pull request URL to its number', async () => {
        const result = await run(['https://github.com/acme/app/pull/42/files']);
        expect(result.code).toBe(0);
        expect(result.calls).toContainEqual(expect.arrayContaining(['checks', '42']));
    });

    it('resolves the current branch’s pull request when given no target', async () => {
        const result = await run([]);
        expect(result.code).toBe(0);
        expect(result.calls[0]).toEqual(['pr', 'view', '--json', 'number', '--jq', '.number']);
        expect(result.stdout).toContain('pr=42\n');
    });

    it.each([[['42', '--timeout', 'soon']], [['42', '--interval']], [['42', '--bogus']], [['not-a-pr']]])(
        'exits 2 on a usage error: %j',
        async (args) => {
            const result = await run(args);
            expect(result.code).toBe(2);
            expect(result.calls).toEqual([]);
        }
    );

    it('is POSIX sh using gh alone: the runner images ship dash and no jq', () => {
        const text = readFileSync(SCRIPT, 'utf8');
        expect(text.startsWith('#!/bin/sh\n')).toBe(true);
        for (const bashism of ['pipefail', '[[', 'local ', '${!', '<<<', 'function ', "$'"]) {
            expect(text).not.toContain(bashism);
        }
        expect(text.replaceAll('--jq', '')).not.toMatch(/\bjq\b/);
    });
});
