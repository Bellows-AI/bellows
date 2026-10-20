import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bindingWriteArgv, bindingWriteScript } from '../src/container-scripts.js';
import { SUPERVISOR_BINDING } from '../src/supervisor-contract.js';

/** The docker executor's binding write (#829), run for real against a temp directory. */
const write = (dir: string, body: string, size = Buffer.byteLength(body), args?: string[]) =>
    spawnSync('sh', ['-c', bindingWriteScript, 'binding-write', ...(args ?? [dir, String(size)])], {
        input: body,
        encoding: 'utf8',
        timeout: 10_000,
    });

const sandbox = () => mkdtempSync(join(tmpdir(), 'binding-write-'));
const BODY = '{"claimSeq":3,"url":"http://board.example","token":"s3cret-token"}';

describe('scripts/binding-write.sh', () => {
    it('builds the exec argv from the contract directory and the byte count', () => {
        expect(bindingWriteArgv(12)).toEqual([
            'sh',
            '-c',
            bindingWriteScript,
            'binding-write',
            SUPERVISOR_BINDING.dir,
            '12',
        ]);
    });

    it('writes the exact bytes at mode 0600 and leaves no temp file', () => {
        const dir = sandbox();
        const run = write(dir, BODY);
        expect(run.status).toBe(0);
        expect(readFileSync(join(dir, SUPERVISOR_BINDING.file), 'utf8')).toBe(BODY);
        expect(statSync(join(dir, SUPERVISOR_BINDING.file)).mode & 0o777).toBe(0o600);
        expect(readdirSync(dir)).toEqual([SUPERVISOR_BINDING.file]);
    });

    it('replaces an existing binding in one rename', () => {
        const dir = sandbox();
        writeFileSync(join(dir, SUPERVISOR_BINDING.file), 'old');
        expect(write(dir, BODY).status).toBe(0);
        expect(readFileSync(join(dir, SUPERVISOR_BINDING.file), 'utf8')).toBe(BODY);
        expect(readdirSync(dir)).toEqual([SUPERVISOR_BINDING.file]);
    });

    it('refuses a short body: exit 65, the old file intact, no temp file left', () => {
        const dir = sandbox();
        writeFileSync(join(dir, SUPERVISOR_BINDING.file), 'old');
        const run = write(dir, BODY.slice(0, 10), BODY.length);
        expect(run.status).toBe(65);
        expect(run.stderr).toContain('binding-write: the binding arrived short');
        expect(readFileSync(join(dir, SUPERVISOR_BINDING.file), 'utf8')).toBe('old');
        expect(readdirSync(dir)).toEqual([SUPERVISOR_BINDING.file]);
    });

    it('never prints the body or the token', () => {
        const dir = sandbox();
        for (const run of [write(dir, BODY), write(dir, BODY.slice(0, 10), BODY.length)]) {
            expect(run.stdout + run.stderr).not.toContain('s3cret-token');
        }
    });

    it('refuses to run without a directory argument', () => {
        const run = write('', BODY, 0, []);
        expect(run.status).not.toBe(0);
        expect(run.stdout + run.stderr).not.toContain('s3cret-token');
    });
});
