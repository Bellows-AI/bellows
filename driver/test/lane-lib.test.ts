import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from './fixtures/repo-files.js';
import { runAsync } from './fixtures/run-async.js';

/*
 * scripts/lane-lib.sh is the harness test-jobs.sh and test-k8s.sh share. These run the real library under bash
 * with the outermost boundary faked: the evidence bundle the first FAIL writes, and the long-lived node helper
 * behind api and field (scripts/lane-api.mjs) against a loopback server.
 */

const dirs: string[] = [];
const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'lane-lib-'));
    dirs.push(dir);
    return dir;
};
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const lib = (dir: string, body: string): Promise<{ status: number | null; stdout: string; stderr: string }> =>
    runAsync(
        'bash',
        [
            '-c',
            `set -uo pipefail; TIMINGS_FILE="$1/t.tsv"; CHECKS_FILE="$1/t.checks.tsv"; pass=0; fail=0; : >"$CHECKS_FILE"\n. "$2/scripts/lane-lib.sh"\n${body}`,
            '_',
            dir,
            REPO_ROOT,
        ],
        { cwd: REPO_ROOT }
    );

describe('the lane evidence bundle', () => {
    it('is written by the first bad(), under evidence-<phase>, with the lane hook output', async () => {
        const dir = scratch();
        const result = await lib(
            dir,
            `lane_collect_evidence() { echo "hook saw $1" >"$1/hook.txt"; }
begin_phase demo
ok 'fine'
bad 'broken' 'wanted 1, got 2'
bad 'second' 'later failure'`
        );
        expect(result.stdout).toContain('FAIL broken');
        const evidence = join(dir, 'evidence-demo');
        expect(readFileSync(join(evidence, 'failure.txt'), 'utf8')).toContain('wanted 1, got 2');
        expect(readFileSync(join(evidence, 'failure.txt'), 'utf8')).toContain('check\tbroken');
        expect(readFileSync(join(evidence, 'checks.tsv'), 'utf8')).toContain('FAIL\tbroken');
        expect(readFileSync(join(evidence, 'hook.txt'), 'utf8')).toContain('hook saw');
        // Only the first FAIL takes a bundle.
        expect(readFileSync(join(evidence, 'failure.txt'), 'utf8')).not.toContain('later failure');
        expect(readdirSync(dir).filter((name) => name.startsWith('evidence-'))).toEqual(['evidence-demo']);
    });

    it('is never written by a passing run', async () => {
        const dir = scratch();
        await lib(dir, `begin_phase demo\nok 'fine'`);
        expect(existsSync(join(dir, 'evidence-demo'))).toBe(false);
    });

    it('survives a lane hook that fails', async () => {
        const dir = scratch();
        const result = await lib(dir, `lane_collect_evidence() { return 1; }\nbegin_phase demo\nbad 'broken' 'x'`);
        expect(result.status).toBe(0);
        expect(existsSync(join(dir, 'evidence-demo', 'failure.txt'))).toBe(true);
    });
});

describe('the lane api helper', () => {
    it('answers api and field through one process, for concurrent callers too', async () => {
        const dir = scratch();
        const server = createServer((req, res) => {
            res.setHeader('content-type', 'application/json');
            res.end(`{"path":"${req.url}","auth":"${req.headers.authorization ?? ''}",\n "n": 1}`);
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const { port } = server.address() as { port: number };
        try {
            const result = await lib(
                dir,
                `lane_api_start
BASE="http://127.0.0.1:${port}"
AUTH_HEADER='Bearer t'
one="$(api GET /one)"
api POST /two '{"a":1}' >"$1/two.out" &
first=$!
api GET /three >"$1/three.out" &
wait "$first" $!
printf 'one=%s\\n' "$one"
printf 'field=%s\\n' "$(field '{"a":"x\\ny"}' a)"
printf 'missing=[%s]\\n' "$(field '{"a":1}' b)"
printf 'broken=[%s]\\n' "$(field 'not json' a)"
printf 'refused=%s\\n' "$(BASE=http://127.0.0.1:1 api GET /x | cut -c1-3)"
lane_api_stop`
            );
            expect(result.stderr).toBe('');
            expect(result.stdout).toContain('one=200\t{"path":"/one","auth":"Bearer t", "n": 1}');
            expect(readFileSync(join(dir, 'two.out'), 'utf8')).toBe('200\t{"path":"/two","auth":"Bearer t", "n": 1}');
            expect(readFileSync(join(dir, 'three.out'), 'utf8')).toBe(
                '200\t{"path":"/three","auth":"Bearer t", "n": 1}'
            );
            expect(result.stdout).toContain('field=x\ny');
            expect(result.stdout).toContain('missing=[]');
            expect(result.stdout).toContain('broken=[]');
            expect(result.stdout).toContain('refused=000');
        } finally {
            server.close();
        }
    });

    it('says so, and never hangs, when the helper is not running', async () => {
        const dir = scratch();
        const result = await lib(dir, `BASE=http://127.0.0.1:1\napi GET /x`);
        expect(result.stdout).toBe('000\tlane api helper is not running');
    });
});
