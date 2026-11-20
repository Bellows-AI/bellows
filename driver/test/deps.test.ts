import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../..');
const ALLOWED = /^(@opentelemetry\/[a-z-]+|@fastify\/otel|pino)$/;
const sourceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === 'scripts' ? [] : sourceFiles(path);
        return entry.name.endsWith('.ts') ? [path] : [];
    });
const packageOf = (specifier: string): string =>
    specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!;

describe('the driver’s dependencies', () => {
    const manifest = (name: string) =>
        JSON.parse(readFileSync(join(root, name, 'package.json'), 'utf8')) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
        };

    it('are the OTEL SDK, its Fastify wrapper and pino only', () => {
        const { dependencies = {}, devDependencies = {} } = manifest('driver');
        for (const name of Object.keys({ ...dependencies, ...devDependencies })) {
            if (name === 'tsx') continue;
            expect(name, `${name} is not on the driver's allowlist`).toMatch(ALLOWED);
        }
        expect(Object.keys(dependencies).length).toBeGreaterThan(0);
    });

    it('leave the cli with none', () => {
        const { dependencies = {}, devDependencies = {} } = manifest('cli');
        expect(Object.keys(dependencies)).toEqual([]);
        expect(Object.keys(devDependencies).filter((n) => n !== 'tsx')).toEqual([]);
    });

    it('cover every bare import under driver/src: node:* or the allowlist', () => {
        const IMPORT = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/g;
        for (const file of sourceFiles(join(root, 'driver/src'))) {
            for (const [, specifier] of readFileSync(file, 'utf8').matchAll(IMPORT)) {
                if (specifier!.startsWith('.') || specifier!.startsWith('node:')) continue;
                expect(packageOf(specifier!), `${file} imports ${specifier}`).toMatch(ALLOWED);
            }
        }
    });

    it('are named in AGENTS.md', () => {
        const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8').replace(/\s+/g, ' ');
        expect(agents).toContain(
            '`driver/` may depend on `@opentelemetry/*`, `@fastify/otel` and `pino` only; `cli/` depends on nothing.'
        );
    });
});
