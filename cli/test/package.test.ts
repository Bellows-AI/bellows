import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('..', import.meta.url));
const root = fileURLToPath(new URL('../..', import.meta.url));
const STAMPED = '9.8.7';

// What `npm publish -w cli` ships, run the way a user runs it: built, packed, stamped like the
// release job stamps it, installed globally under a throwaway prefix, and called through its bin.
// Offline: the package has no dependency to fetch.
describe('the packed @bellows-ai/bellows-cli', () => {
    let bellows: (...args: string[]) => string;
    let files: string[];

    beforeAll(() => {
        const work = mkdtempSync(join(tmpdir(), 'bellows-pack-'));
        execFileSync('npx', ['tsc', '-b', cli], { cwd: root, stdio: 'ignore' });
        const [packed] = JSON.parse(
            execFileSync('npm', ['pack', '--json', '--pack-destination', work], { cwd: cli, encoding: 'utf8' })
        ) as { filename: string; files: { path: string }[] }[];
        files = packed!.files.map((file) => file.path).sort();
        execFileSync('tar', ['-xzf', join(work, packed!.filename), '-C', work]);
        // The release job's `npm pkg set version`, applied to the copy so the checkout stays 0.0.0.
        const manifest = join(work, 'package', 'package.json');
        writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), version: STAMPED }));
        const pkg = join(work, 'package');
        const prefix = join(work, 'prefix');
        execFileSync(
            'npm',
            ['install', '--global', '--prefix', prefix, '--offline', '--no-audit', '--no-fund', '--install-links', pkg],
            {
                stdio: 'ignore',
            }
        );
        bellows = (...args) =>
            execFileSync(join(prefix, 'bin', 'bellows'), args, { encoding: 'utf8', env: { PATH: process.env.PATH } });
    }, 120_000);

    it('ships the compiled JS and nothing of the source, the tests or the declarations', () => {
        expect(files.filter((file) => !/^dist\/[\w-]+\.js$/.test(file))).toEqual(['README.md', 'package.json']);
        expect(files).toContain('dist/index.js');
    });

    it('answers --version with the stamped version, read from inside the installed package', () => {
        expect(bellows('--version')).toBe(`bellows ${STAMPED}\n`);
    });

    it('answers help through the installed bin with no board configured', () => {
        expect(bellows('help')).toMatch(/^usage: bellows job create/);
    });
});
