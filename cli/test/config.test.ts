import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CliConfigError, loadCliConfig } from '../src/config.js';
import { BOARD_URL, json, NO_SETTINGS as ABSENT, runCli } from './harness.js';

const load = (env: NodeJS.ProcessEnv) => loadCliConfig(env, ABSENT);

/** A settings file in its own fresh directory, `content` serialized unless it is already text. */
function settingsFile(content: unknown, mode = 0o600): string {
    const path = join(mkdtempSync(join(tmpdir(), 'bellows-settings-')), 'settings.json');
    writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
    chmodSync(path, mode);
    return path;
}

const refusalOf = (fn: () => unknown): Error | null => {
    try {
        fn();
    } catch (error) {
        return error as Error;
    }
    return null;
};

describe('loadCliConfig', () => {
    it('reads FACTORY_URL and FACTORY_TOKEN, stripping a trailing slash', () => {
        const config = load({ FACTORY_URL: 'http://board:8080/', FACTORY_TOKEN: ' fat_abc ' });
        expect(config.url).toBe('http://board:8080');
        expect(config.token).toBe('fat_abc');
    });

    it('refuses a missing or blank FACTORY_URL, naming the variable', () => {
        expect(() => load({})).toThrow(/FACTORY_URL/);
        expect(() => load({ FACTORY_URL: '   ' })).toThrow(/FACTORY_URL/);
    });

    it('refuses a FACTORY_URL that is not an http(s) URL', () => {
        // `new URL('dashboard:8080')` parses with 'dashboard:' as the scheme; the protocol is
        // checked, not just the parse, or every call would 404 against a value that reads well.
        expect(() => load({ FACTORY_URL: 'dashboard:8080' })).toThrow(/FACTORY_URL/);
    });

    it('refuses a FACTORY_URL carrying user:password without echoing it', () => {
        for (const url of ['http://u:hunter2@board', 'ftp://u:hunter2@board']) {
            const refusal = refusalOf(() => load({ FACTORY_URL: url }));
            expect(refusal).toBeInstanceOf(CliConfigError);
            expect(refusal!.message).toMatch(/FACTORY_URL.*FACTORY_TOKEN/);
            expect(refusal!.message).not.toContain('hunter2');
        }
    });

    it('defaults the request deadline and read retries, and reads both overrides', () => {
        const defaults = load({ FACTORY_URL: 'http://board' });
        expect(defaults).toMatchObject({ requestTimeoutMs: 30_000, readRetries: 3 });

        const tuned = load({
            FACTORY_URL: 'http://board',
            FACTORY_REQUEST_TIMEOUT_S: '5',
            FACTORY_READ_RETRIES: '0',
        });
        expect(tuned).toMatchObject({ requestTimeoutMs: 5_000, readRetries: 0 });
    });

    it.each([
        ['FACTORY_REQUEST_TIMEOUT_S', '0'],
        ['FACTORY_REQUEST_TIMEOUT_S', 'soon'],
        ['FACTORY_READ_RETRIES', '-1'],
        ['FACTORY_READ_RETRIES', '1.5'],
        ['FACTORY_READ_RETRIES', '99'],
    ])('refuses %s=%s, naming the variable', (name, value) => {
        expect(() => load({ FACTORY_URL: 'http://board', [name]: value })).toThrow(name);
    });

    it('reads a blank FACTORY_TOKEN as empty and trims a real one', () => {
        // A blank token is "no credential", the AUTH_MODE=none case — never an empty Bearer.
        expect(load({ FACTORY_URL: 'http://board' }).token).toBe('');
        expect(load({ FACTORY_URL: 'http://board', FACTORY_TOKEN: '' }).token).toBe('');
    });
});

describe('loadCliConfig: settings file', () => {
    it('reads env only when the default path is absent, every value sourced env or default', () => {
        const config = load({ FACTORY_URL: 'http://board', FACTORY_TOKEN: 'fat_abc' });
        expect(config).toMatchObject({ url: 'http://board', token: 'fat_abc', requestTimeoutMs: 30_000 });
        expect(config.sources).toEqual({
            url: 'env',
            token: 'env',
            requestTimeoutS: 'default',
            readRetries: 'default',
        });
    });

    it('reads every key from a default file that exists, naming the file as their source', () => {
        const path = settingsFile({ url: 'http://filed/', token: 'fat_file', requestTimeoutS: 7, readRetries: 0 });
        const config = loadCliConfig({}, { path, explicit: false });
        expect(config).toMatchObject({
            url: 'http://filed',
            token: 'fat_file',
            requestTimeoutMs: 7_000,
            readRetries: 0,
        });
        expect(config.sources).toEqual({ url: path, token: path, requestTimeoutS: path, readRetries: path });
    });

    it('reads an explicit --config file the same way', () => {
        const path = settingsFile({ url: 'http://explicit' });
        expect(loadCliConfig({}, { path, explicit: true }).url).toBe('http://explicit');
    });

    it('refuses an explicit file that does not exist, naming the path', () => {
        const refusal = refusalOf(() => loadCliConfig({ FACTORY_URL: 'http://board' }, { ...ABSENT, explicit: true }));
        expect(refusal).toBeInstanceOf(CliConfigError);
        expect(refusal!.message).toContain(ABSENT.path);
    });

    it('lets a set variable override the file, key by key', () => {
        const path = settingsFile({ url: 'http://filed', token: 'fat_file', requestTimeoutS: 7, readRetries: 1 });
        const settings = { path, explicit: false };
        expect(loadCliConfig({ FACTORY_URL: 'http://env' }, settings)).toMatchObject({
            url: 'http://env',
            token: 'fat_file',
            requestTimeoutMs: 7_000,
            readRetries: 1,
            sources: { url: 'env', token: path, requestTimeoutS: path, readRetries: path },
        });
        expect(loadCliConfig({ FACTORY_TOKEN: 'fat_env' }, settings)).toMatchObject({ token: 'fat_env' });
        expect(loadCliConfig({ FACTORY_REQUEST_TIMEOUT_S: '9' }, settings)).toMatchObject({ requestTimeoutMs: 9_000 });
        expect(loadCliConfig({ FACTORY_READ_RETRIES: '2' }, settings)).toMatchObject({ readRetries: 2 });
    });

    it('does not let a blank variable override the file', () => {
        const path = settingsFile({ url: 'http://filed', token: 'fat_file' });
        const config = loadCliConfig({ FACTORY_URL: '  ', FACTORY_TOKEN: '' }, { path, explicit: false });
        expect(config).toMatchObject({ url: 'http://filed', token: 'fat_file' });
    });

    it.each([
        ['invalid JSON', '{"url": '],
        ['a non-object', '["http://board"]'],
        ['an unknown key', { url: 'http://board', retries: 2 }],
        ['a url that is not a string', { url: 8080 }],
        ['a number written as a string', { url: 'http://board', readRetries: '2' }],
    ])('refuses %s, naming the path', (_label, content) => {
        const path = settingsFile(content);
        const refusal = refusalOf(() => loadCliConfig({}, { path, explicit: false }));
        expect(refusal).toBeInstanceOf(CliConfigError);
        expect(refusal!.message).toContain(path);
    });

    it('validates a file value as it would a variable, naming the key in the file', () => {
        const path = settingsFile({ url: 'http://board', readRetries: 99 });
        expect(() => loadCliConfig({}, { path, explicit: false })).toThrow(`${path}: readRetries must be an integer`);

        const secret = settingsFile({ url: 'http://u:hunter2@board' });
        const refusal = refusalOf(() => loadCliConfig({}, { path: secret, explicit: false }));
        expect(refusal!.message).toContain(`${secret}: url`);
        expect(refusal!.message).not.toContain('hunter2');
    });

    it('refuses a url missing from both the environment and the file, naming both', () => {
        const path = settingsFile({ token: 'fat_file' });
        const refusal = refusalOf(() => loadCliConfig({}, { path, explicit: false }));
        expect(refusal!.message).toMatch(/FACTORY_URL/);
        expect(refusal!.message).toContain(path);
    });

    it.skipIf(process.platform === 'win32')('refuses a token in a file readable beyond its owner', () => {
        for (const mode of [0o644, 0o640, 0o604]) {
            const path = settingsFile({ url: 'http://board', token: 'fat_file' }, mode);
            const refusal = refusalOf(() => loadCliConfig({}, { path, explicit: false }));
            expect(refusal).toBeInstanceOf(CliConfigError);
            expect(refusal!.message).toContain(`chmod 600 ${path}`);
            expect(refusal!.message).not.toContain('fat_file');
        }
        // A wide file without a token holds nothing secret.
        const open = settingsFile({ url: 'http://board' }, 0o644);
        expect(loadCliConfig({}, { path: open, explicit: false }).url).toBe('http://board');
    });
});

describe('--config', () => {
    const version = () => json({ version: '9.9.9' });

    it('reads the named file wherever the flag sits among the options', async () => {
        const path = settingsFile({ url: BOARD_URL });
        for (const argv of [
            ['--config', path, 'job', 'list'],
            ['job', 'list', `--config=${path}`],
        ]) {
            const { code, sent } = await runCli(argv, () => json({ jobs: [] }), { env: {} });
            expect(code).toBe(0);
            expect(sent.map((call) => call.url)).toEqual([`${BOARD_URL}/api/jobs`]);
        }
    });

    it('refuses a named file that does not exist: exit 2, the path named, no request', async () => {
        const { code, err, sent } = await runCli(['job', 'list', '--config', ABSENT.path], version);
        expect(code).toBe(2);
        expect(err).toContain(ABSENT.path);
        expect(sent).toEqual([]);
    });

    it('refuses the flag without a path, or given twice', async () => {
        expect((await runCli(['job', 'list', '--config'], version)).code).toBe(2);
        expect((await runCli(['job', 'list', '--config', '--json'], version)).code).toBe(2);
        const twice = await runCli(['--config', 'a', 'job', 'list', '--config', 'b'], version);
        expect(twice.code).toBe(2);
        expect(twice.err).toMatch(/--config/);
    });

    it('leaves a --config after -- to the task command', async () => {
        const { code, sent } = await runCli(['job', 'create', '--repo', 'o/r', '--', 'run', '--config', 'x'], () =>
            json({ id: 'job-1', status: 'queued' }, 201)
        );
        expect(code).toBe(0);
        expect(sent[0]!.body).toMatchObject({ command: 'run --config x' });
    });

    it('never reads the file for help or --version', async () => {
        expect((await runCli(['--help', '--config', ABSENT.path], version)).code).toBe(0);
        expect((await runCli(['--config', ABSENT.path, '--version'], version)).code).toBe(0);
    });
});
