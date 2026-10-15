import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertTestDatabase } from '../test-db/harness.js';

describe('assertTestDatabase', () => {
    it('accepts a database whose name marks it disposable', () => {
        expect(() => assertTestDatabase('postgres://factory:factory@127.0.0.1:5432/factory_test')).not.toThrow();
    });

    it('refuses a database whose name is not marked disposable, naming it', () => {
        expect(() => assertTestDatabase('postgres://factory:factory@127.0.0.1:5432/factory_dev')).toThrow(
            /factory_dev/
        );
    });
});

describe('db suites generate their ids', () => {
    const dir = new URL('../test-db/', import.meta.url);
    const files = readdirSync(dir).filter((name) => name.endsWith('.ts'));

    /** Each pattern is a literal id: a uuid, an org, or a github id the fixtures should generate. */
    const LINE_PATTERNS = [
        /['"`][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}['"`]/i,
        /\b\w*ORG\w*\s*=\s*['"`\d]/,
        /\borgId:\s*['"`\d]/,
        /\borgs:\s*\[\s*['"`\d]/,
        /\bgithubUserId:\s*\d/,
        /\baccount\(\s*sql\s*,[^,]*\b\d/,
        /\b\w*(GITHUB_ID|ID_BASE)\w*\s*=\s*\d/,
    ];
    const FILE_PATTERNS = [/github_user_id[^`]*?values\s*\([^)]*?\b\d[\d_]{3,}/g];

    it('scans every db suite', () => {
        expect(files.length).toBeGreaterThan(0);
    });

    it('hardcodes no uuid, org or github id', () => {
        const offenders: string[] = [];
        for (const name of files) {
            const source = readFileSync(new URL(name, dir), 'utf8');
            source.split('\n').forEach((line, index) => {
                if (LINE_PATTERNS.some((pattern) => pattern.test(line))) offenders.push(`${name}:${index + 1}`);
            });
            for (const pattern of FILE_PATTERNS) {
                for (const match of source.matchAll(pattern)) {
                    offenders.push(`${name}:${source.slice(0, match.index).split('\n').length}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});
