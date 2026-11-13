import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { boardCredentialOf } from '../src/board-credential.js';

/**
 * The credential the driver presents on every board call. From a file it is read again for each call, so a
 * rotated Secret (the kubelet swaps the mounted file in place) or a rewritten compose file takes effect with no
 * restart, inside the old credential's overlap window. A read that cannot answer keeps the last good value.
 */
const OLD = `drv_${'0a'.repeat(32)}`;
const NEW = `drv_${'0b'.repeat(32)}`;
const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function credentialFile(content: string) {
    const dir = mkdtempSync(join(tmpdir(), 'driver-credential-'));
    dirs.push(dir);
    const file = join(dir, 'credential');
    writeFileSync(file, content);
    return file;
}

describe('the board credential', () => {
    it('is the configured value, or none', () => {
        expect(boardCredentialOf({ boardCredential: OLD, boardCredentialFile: null })()).toBe(OLD);
        expect(boardCredentialOf({ boardCredential: '', boardCredentialFile: null })()).toBe('');
    });

    it('re-reads its file on every call: a rotated credential is presented without a restart', () => {
        const file = credentialFile(`${OLD}\n`);
        const credential = boardCredentialOf({ boardCredential: '', boardCredentialFile: file });
        expect(credential()).toBe(OLD);
        writeFileSync(file, `${NEW}\n`);
        expect(credential()).toBe(NEW);
    });

    it('keeps the last good credential through a read that cannot answer: missing, empty or malformed', () => {
        const file = credentialFile(OLD);
        const credential = boardCredentialOf({ boardCredential: '', boardCredentialFile: file });
        rmSync(file);
        expect(credential()).toBe(OLD);
        writeFileSync(file, '');
        expect(credential()).toBe(OLD);
        writeFileSync(file, 'half-written');
        expect(credential()).toBe(OLD);
    });

    it('refuses to start on a file it cannot read or that holds no credential, without echoing it', () => {
        expect(() =>
            boardCredentialOf({ boardCredential: '', boardCredentialFile: '/nonexistent/credential' })
        ).toThrow(/DRIVER_CREDENTIAL_FILE/);
        const file = credentialFile('hunter2');
        expect(() => boardCredentialOf({ boardCredential: '', boardCredentialFile: file })).toThrow(
            /DRIVER_CREDENTIAL_FILE/
        );
        expect(() => boardCredentialOf({ boardCredential: '', boardCredentialFile: file })).not.toThrow(/hunter2/);
    });
});
