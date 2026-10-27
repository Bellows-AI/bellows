import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as input from '../src/secrets/secret-input.js';
import * as contract from '../src/secrets/secret-store.js';

const SRC = join(import.meta.dirname, '..', 'src');

function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
    });
}

describe('the secret-store test helpers cannot become a production backend', () => {
    it('no file under server/src imports from a test directory', () => {
        const offenders = sourceFiles(SRC).filter((file) =>
            /from\s+['"][^'"]*\/(test|test-db)\/[^'"]*['"]|from\s+['"]\.\.\/test/.test(readFileSync(file, 'utf8'))
        );
        expect(offenders).toEqual([]);
    });

    it('the shipped secrets modules export validators and constants, never a store factory', () => {
        expect(Object.keys(input).sort()).toEqual([
            'MAX_SECRET_BYTES',
            'OPERATION_RETENTION_MS',
            'createSecretRef',
            'identityKey',
            'isSecretRef',
            'sameIdentity',
            'secretError',
            'validateIdentity',
            'validatePayload',
        ]);
        expect(Object.keys(contract).sort()).toEqual([
            'SECRET_ERROR_CODES',
            'SECRET_ERROR_REASONS',
            'SECRET_PURPOSES',
            'SECRET_SCOPE_TYPES',
        ]);
    });

    it('main.ts composes no secret store yet', () => {
        expect(readFileSync(join(SRC, 'main.ts'), 'utf8')).not.toMatch(/secrets/i);
    });
});
