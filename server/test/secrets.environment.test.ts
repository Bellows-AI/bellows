import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * The secret store's keys decrypt every stored credential, so they reach the dashboard process and
 * nothing else (docs/secrets.md). Everything that launches the driver, the CLI or a runner is built
 * from the same checkout and often the same shell, so the separation is pinned in the bytes that
 * launch each one: the keys live in secrets.env, only the dashboard's launchers read it, and the
 * driver strips what it is nonetheless handed.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
/** The array expansion every board launch carries; split so the template-literal lint does not read it as one. */
const BOARD_ENV = ['"$', '{SECRET_STORE_ENV[@]}"'].join('');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const scripts = (path: string) => (JSON.parse(read(path)) as { scripts: Record<string, string> }).scripts;

/** The text of one top-level service of docker-compose.yml. */
function composeService(name: string): string {
    const compose = read('docker-compose.yml');
    const start = compose.search(new RegExp(`^    ${name}:\\s*$`, 'm'));
    expect(start, `service ${name}`).toBeGreaterThanOrEqual(0);
    const rest = compose.slice(start + 1);
    const next = rest.search(/^ {4}[a-z][a-z0-9-]*:\s*$|^[a-z]/m);
    return next < 0 ? rest : rest.slice(0, next);
}

describe('the secret-store keys stay in the dashboard process', () => {
    it('secrets.env is neither committed nor shipped into an image', () => {
        expect(read('.gitignore')).toMatch(/^\/?secrets\.env$/m);
        expect(read('.dockerignore')).toMatch(/^\/?secrets\.env$/m);
    });

    it('secrets:init writes all four variables and never overwrites an existing file', () => {
        expect(scripts('package.json')['secrets:init']).toBe('node scripts/secrets-init.mjs');
        const init = read('scripts/secrets-init.mjs');
        for (const name of [
            'SECRETS_DATA_KEYS',
            'SECRETS_ACTIVE_KEY_ID',
            'SECRETS_OPERATION_KEY',
            'SECRETS_FINGERPRINT_KEY',
        ]) {
            expect(init).toContain(name);
        }
        expect(init).toContain("flag: 'wx'");
    });

    it('only the dashboard launchers load secrets.env', () => {
        const root = scripts('package.json');
        const mentions = (s: Record<string, string>) => Object.keys(s).filter((k) => s[k]?.includes('secrets.env'));
        expect(mentions(root).sort()).toEqual(['secrets:rotate', 'start']);
        expect(scripts('server/package.json').dev).toContain('--env-file-if-exists=../secrets.env');
        expect(mentions(scripts('server/package.json'))).toEqual(['dev']);
        expect(mentions(scripts('driver/package.json'))).toEqual([]);
        expect(mentions(scripts('cli/package.json'))).toEqual([]);
        expect(mentions(scripts('web/package.json'))).toEqual([]);
    });

    it('docker compose gives the dashboard the file and every other service nothing', () => {
        const compose = read('docker-compose.yml');
        const dashboard = composeService('dashboard');
        expect(dashboard).toMatch(/env_file:[\s\S]*secrets\.env/);
        for (const other of compose.matchAll(/^ {4}([a-z][a-z0-9-]*):\s*$/gm)) {
            const name = other[1] as string;
            if (name === 'dashboard') continue;
            const service = composeService(name);
            expect(service, name).not.toContain('SECRETS_');
            expect(service, name).not.toMatch(/secrets\.env|SECRETS_ENV_FILE/);
        }
        expect(compose).not.toMatch(/\$\{SECRETS_(DATA|ACTIVE|OPERATION|FINGERPRINT)/);
    });

    it('the driver strips SECRETS_* before it reads its configuration', () => {
        const index = read('driver/src/index.ts');
        expect(index.indexOf('stripSecretStoreEnv(process.env)')).toBeGreaterThanOrEqual(0);
        expect(index.indexOf('stripSecretStoreEnv(process.env)')).toBeLessThan(
            index.indexOf('loadDriverConfig(process.env)')
        );
    });

    describe('scripts/test-jobs.sh', () => {
        const script = read('scripts/test-jobs.sh');
        const lines = script.split('\n').map((line) => (line.trimStart().startsWith('#') ? '' : line));

        it('exports no key and puts keys only on a board launch', () => {
            expect(script).not.toMatch(/export\s+SECRETS_/);
            expect(script).not.toMatch(/declare\s+-x\s+SECRETS_/);
            const carriers = lines.flatMap((line, i) => (line.includes('SECRET_STORE_ENV') ? [i] : []));
            expect(carriers.length).toBeGreaterThan(0);
            for (const i of carriers) {
                const launch = lines.slice(i, i + 8).join('\n');
                const defines = /SECRET_STORE_ENV=\(|>"\$SECRETS_ENV_FILE_PATH"/.test(lines[i] ?? '');
                expect(defines || /server\/dist\/offline(-mint)?\.js/.test(launch), `line ${i + 1}`).toBe(true);
            }
        });

        it('hands every board launch the keys and no driver launch anything', () => {
            for (const [i, line] of lines.entries()) {
                if (/node server\/dist\/offline(-mint)?\.js/.test(line)) {
                    const launch = lines.slice(Math.max(0, i - 8), i + 1).join('\n');
                    expect(launch, `line ${i + 1}`).toContain(BOARD_ENV);
                }
                if (/node driver\/dist\/index\.js/.test(line)) {
                    const launch = lines.slice(Math.max(0, i - 12), i + 1).join('\n');
                    expect(launch, `line ${i + 1}`).not.toMatch(/SECRET_STORE_ENV|SECRETS_/);
                }
            }
        });

        it('feeds compose its dashboard env file from a per-run path', () => {
            expect(script).toMatch(/compose\(\) \{[^}]*SECRETS_ENV_FILE=/);
        });
    });

    it('the playwright boards share disposable literal keys, and only the two server blocks spread them', () => {
        const config = read('playwright.config.ts');
        const shared = config.slice(
            config.indexOf('const shared = {'),
            config.indexOf('};', config.indexOf('const shared = {'))
        );
        for (const name of [
            'SECRETS_DATA_KEYS',
            'SECRETS_ACTIVE_KEY_ID',
            'SECRETS_OPERATION_KEY',
            'SECRETS_FINGERPRINT_KEY',
        ]) {
            expect(shared).toContain(name);
        }
        expect(config.match(/\.\.\.shared,/g)).toHaveLength(2);
        expect(config.match(/SECRETS_/g)).toHaveLength(4);
    });
});
