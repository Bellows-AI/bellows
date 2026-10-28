import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** `npm run secrets:init` (docs/secrets.md): writes a fresh file, and adds the backend line to one an older release wrote. */
const SCRIPT = fileURLToPath(new URL('../../scripts/secrets-init.mjs', import.meta.url));
const KEYS = [
    'SECRETS_DATA_KEYS=k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    'SECRETS_ACTIVE_KEY_ID=k1',
    'SECRETS_OPERATION_KEY=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=',
    'SECRETS_FINGERPRINT_KEY=CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=',
];

function run(path: string): string {
    return execFileSync('node', [SCRIPT, path], { encoding: 'utf8' });
}

function target(content?: string): string {
    const path = join(mkdtempSync(join(tmpdir(), 'secrets-init-')), 'secrets.env');
    if (content !== undefined) writeFileSync(path, content, { mode: 0o600 });
    return path;
}

describe('scripts/secrets-init.mjs', () => {
    it('writes a fresh file with every key and the database backend, readable by its owner only', () => {
        const path = target();
        run(path);
        const lines = readFileSync(path, 'utf8').split('\n');
        expect(lines).toContain('SECRETS_BACKEND=database');
        for (const name of [
            'SECRETS_DATA_KEYS',
            'SECRETS_ACTIVE_KEY_ID',
            'SECRETS_OPERATION_KEY',
            'SECRETS_FINGERPRINT_KEY',
        ]) {
            expect(lines.some((line) => line.startsWith(`${name}=`) && line.length > name.length + 1)).toBe(true);
        }
        expect(statSync(path).mode & 0o777).toBe(0o600);
    });

    it('adds the missing backend line to an existing file and leaves every key byte for byte', () => {
        const original = `${KEYS.join('\n')}\n`;
        const path = target(original);
        run(path);
        const after = readFileSync(path, 'utf8');
        expect(after.split('\n')).toEqual([...KEYS, 'SECRETS_BACKEND=database', '']);
        expect(after.startsWith(original)).toBe(true);
    });

    it('adds the line to a file that does not end in a newline', () => {
        const path = target(KEYS.join('\n'));
        run(path);
        expect(readFileSync(path, 'utf8').split('\n')).toEqual([...KEYS, 'SECRETS_BACKEND=database', '']);
    });

    it('is idempotent', () => {
        const path = target(`${KEYS.join('\n')}\n`);
        run(path);
        const once = readFileSync(path, 'utf8');
        run(path);
        expect(readFileSync(path, 'utf8')).toBe(once);
    });

    it('keeps a backend the file already selects', () => {
        const original = `${KEYS.join('\n')}\nSECRETS_BACKEND=aws\n`;
        const path = target(original);
        run(path);
        expect(readFileSync(path, 'utf8')).toBe(original);
    });

    it('does not read a commented-out backend as a selection', () => {
        const path = target(`# SECRETS_BACKEND=aws\n${KEYS.join('\n')}\n`);
        run(path);
        expect(readFileSync(path, 'utf8')).toContain('\nSECRETS_BACKEND=database\n');
    });

    it('preserves the permissions of the file it extends', () => {
        const path = target(`${KEYS.join('\n')}\n`);
        run(path);
        expect(statSync(path).mode & 0o777).toBe(0o600);
    });
});
