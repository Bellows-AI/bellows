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

    it('main.ts calls loadSecretBackend before postgres( and passes secrets to buildApp', () => {
        const main = readFileSync(join(SRC, 'main.ts'), 'utf8');
        const keys = main.indexOf('loadSecretBackend(process.env)');
        expect(keys).toBeGreaterThan(main.indexOf('resolveConfig('));
        expect(keys).toBeLessThan(main.indexOf('postgres('));
        expect(main).toMatch(/createSecretStore\(\{[^}]*\bsql\b[^}]*\bbackend\b/s);
        expect(main).toMatch(/buildApp\(\{[\s\S]*\bsecrets\b[\s\S]*\}\)/);
        expect(main).toContain("timedPass('secret_collect'");
    });

    it('only main.ts, the rotation and the conversion command read the key environment', () => {
        const readers = sourceFiles(SRC)
            .filter((file) =>
                /load(SecretBackend|SecretKeys|OperationKeys)\(|rotationKeys\(/.test(readFileSync(file, 'utf8'))
            )
            .map((file) => file.slice(SRC.length + 1))
            .sort();
        expect(readers).toEqual([
            'main.ts',
            'secrets/convert-env-cli.ts',
            'secrets/rotate-cli.ts',
            'secrets/secret-backend.ts',
            'secrets/secret-keys.ts',
        ]);
    });
});
