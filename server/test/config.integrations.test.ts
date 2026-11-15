import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';

const BASE = {
    DATABASE_URL: 'postgres://factory:factory@127.0.0.1:5432/factory_dev',
    GITHUB_APP_ID: '123',
    GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\nshape-checked-only\n-----END RSA PRIVATE KEY-----',
};

const load = (env: NodeJS.ProcessEnv) => loadConfig({ ...BASE, ...env });

afterEach(() => {
    vi.restoreAllMocks();
});

describe('integrations.jira', () => {
    it('ATLASSIAN_CLIENT_ID and SECRET configure Jira with the default Atlassian URLs', () => {
        expect(load({ ATLASSIAN_CLIENT_ID: 'cid', ATLASSIAN_CLIENT_SECRET: 'csecret' }).integrations.jira).toEqual({
            clientId: 'cid',
            clientSecret: 'csecret',
            authorizeUrl: 'https://auth.atlassian.com/authorize',
            tokenUrl: 'https://auth.atlassian.com/oauth/token',
            apiOrigin: 'https://api.atlassian.com',
        });
    });

    it('only one of the two refuses the boot naming the other', () => {
        expect(() => load({ ATLASSIAN_CLIENT_ID: 'cid' })).toThrow(/ATLASSIAN_CLIENT_SECRET is not set/);
        expect(() => load({ ATLASSIAN_CLIENT_SECRET: 'csecret' })).toThrow(/ATLASSIAN_CLIENT_ID is not set/);
    });

    it('neither leaves Jira unconfigured, which never fails the boot', () => {
        expect(load({}).integrations.jira).toBeNull();
    });

    it('an override URL warns once and must be absolute http(s)', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const env = { ATLASSIAN_CLIENT_ID: 'cid', ATLASSIAN_CLIENT_SECRET: 'csecret' };
        expect(load(env).integrations.jira).not.toBeNull();
        expect(warn).not.toHaveBeenCalled();
        const config = load({
            ...env,
            ATLASSIAN_API_URL: 'http://127.0.0.1:9999/',
            ATLASSIAN_TOKEN_URL: 'http://127.0.0.1:9999/t',
        });
        expect(config.integrations.jira?.apiOrigin).toBe('http://127.0.0.1:9999');
        expect(config.integrations.jira?.tokenUrl).toBe('http://127.0.0.1:9999/t');
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]?.[0])).toContain('Atlassian');
        for (const name of ['ATLASSIAN_AUTHORIZE_URL', 'ATLASSIAN_TOKEN_URL', 'ATLASSIAN_API_URL']) {
            expect(() => load({ ...env, [name]: 'not a url' })).toThrow(new RegExp(name));
            expect(() => load({ ...env, [name]: 'ftp://example.test/x' })).toThrow(new RegExp(name));
        }
    });
});

describe('integrations.linear', () => {
    it('LINEAR_CLIENT_ID and SECRET configure Linear with the default Linear URLs', () => {
        expect(load({ LINEAR_CLIENT_ID: 'lid', LINEAR_CLIENT_SECRET: 'lsecret' }).integrations.linear).toEqual({
            clientId: 'lid',
            clientSecret: 'lsecret',
            authorizeUrl: 'https://linear.app/oauth/authorize',
            apiOrigin: 'https://api.linear.app',
        });
    });

    it('is both or neither, naming the missing half', () => {
        expect(() => load({ LINEAR_CLIENT_ID: 'lid' })).toThrow(/LINEAR_CLIENT_SECRET is not set/);
        expect(() => load({ LINEAR_CLIENT_SECRET: 'lsecret' })).toThrow(/LINEAR_CLIENT_ID is not set/);
    });

    it('is null when unset, whatever Jira is', () => {
        expect(load({}).integrations.linear).toBeNull();
        expect(load({ ATLASSIAN_CLIENT_ID: 'cid', ATLASSIAN_CLIENT_SECRET: 'cs' }).integrations.linear).toBeNull();
    });

    it('an override URL warns once and must be absolute http(s)', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const env = { LINEAR_CLIENT_ID: 'lid', LINEAR_CLIENT_SECRET: 'lsecret' };
        expect(load(env).integrations.linear).not.toBeNull();
        expect(warn).not.toHaveBeenCalled();
        const config = load({
            ...env,
            LINEAR_API_URL: 'http://127.0.0.1:9999/linear/',
            LINEAR_AUTHORIZE_URL: 'http://127.0.0.1:9999/linear/authorize',
        });
        expect(config.integrations.linear?.apiOrigin).toBe('http://127.0.0.1:9999/linear');
        expect(config.integrations.linear?.authorizeUrl).toBe('http://127.0.0.1:9999/linear/authorize');
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]?.[0])).toContain('Linear');
        for (const name of ['LINEAR_AUTHORIZE_URL', 'LINEAR_API_URL']) {
            expect(() => load({ ...env, [name]: 'not a url' })).toThrow(new RegExp(name));
            expect(() => load({ ...env, [name]: 'ftp://example.test/x' })).toThrow(new RegExp(name));
        }
    });
});
