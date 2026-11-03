import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const BASE = {
    DATABASE_URL: 'postgres://factory:factory@127.0.0.1:5432/factory_dev',
    GITHUB_APP_ID: '123',
    GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\nshape-checked-only\n-----END RSA PRIVATE KEY-----',
};
const SECRET = 'a-secret-that-is-at-least-32-characters';

const load = (env: NodeJS.ProcessEnv) => loadConfig({ ...BASE, ...env });

const github = (env: NodeJS.ProcessEnv = {}) =>
    load({
        AUTH_MODE: 'github',
        GITHUB_OAUTH_CLIENT_ID: 'client-id',
        GITHUB_OAUTH_CLIENT_SECRET: 'client-secret',
        SESSION_SECRET: SECRET,
        JOB_BOARD_TOKEN: SECRET,
        ...env,
    });

describe('MCP_ENABLED', () => {
    it('is off with no variables, and ignores the origins list while off', () => {
        expect(load({}).mcp).toEqual({ enabled: false });
        expect(load({ MCP_TRUSTED_ORIGINS: 'not an origin' }).mcp).toEqual({ enabled: false });
        expect(load({ MCP_ENABLED: 'false', PUBLIC_URL: 'http://board.example' }).mcp).toEqual({ enabled: false });
    });

    it('refuses a value that is not a boolean, naming it', () => {
        expect(() => load({ MCP_ENABLED: 'maybe' })).toThrow(/MCP_ENABLED must be a boolean/);
    });

    it('is allowed over https on any host, and serves the resource under the public origin', () => {
        const mcp = github({ MCP_ENABLED: '1', PUBLIC_URL: 'https://board.example', HOST: '0.0.0.0' }).mcp;
        expect(mcp).toEqual({ enabled: true, resource: 'https://board.example/api/mcp', trustedOrigins: [] });
    });

    it('is allowed over http only when both the public origin and the bind are loopback', () => {
        expect(load({ MCP_ENABLED: 'true' }).mcp).toMatchObject({
            enabled: true,
            resource: 'http://127.0.0.1:8080/api/mcp',
        });
        expect(
            github({ MCP_ENABLED: 'true', PUBLIC_URL: 'http://localhost:3000', HOST: '127.0.0.1' }).mcp
        ).toMatchObject({ enabled: true, resource: 'http://localhost:3000/api/mcp' });
    });

    it('refuses an http public origin that is not loopback', () => {
        expect(() => github({ MCP_ENABLED: '1', PUBLIC_URL: 'http://board.example', HOST: '0.0.0.0' })).toThrow(
            /MCP_ENABLED.*https/
        );
    });

    it('refuses a loopback http public origin on a bind that is reachable from off the machine', () => {
        expect(() => github({ MCP_ENABLED: '1', PUBLIC_URL: 'http://127.0.0.1:8080', HOST: '0.0.0.0' })).toThrow(
            /MCP_ENABLED.*HOST/
        );
    });

    it('refuses to enable with no public origin to name the resource', () => {
        expect(() => load({ MCP_ENABLED: '1', HOST: '0.0.0.0', AUTH_ALLOW_PUBLIC_BIND: '1' })).toThrow(/PUBLIC_URL/);
    });
});

describe('MCP_TRUSTED_ORIGINS', () => {
    const on = { MCP_ENABLED: '1', PUBLIC_URL: 'https://board.example', HOST: '0.0.0.0' };

    it('is a comma list of exact origins', () => {
        const mcp = github({ ...on, MCP_TRUSTED_ORIGINS: ' https://app.example , http://localhost:6274 ' }).mcp;
        expect(mcp).toMatchObject({ enabled: true, trustedOrigins: ['https://app.example', 'http://localhost:6274'] });
    });

    it.each(['*', 'https://*.example', 'https://app.example/path', 'app.example', 'ftp://app.example'])(
        'refuses %s, which is not an exact origin',
        (entry) => {
            expect(() => github({ ...on, MCP_TRUSTED_ORIGINS: entry })).toThrow(/MCP_TRUSTED_ORIGINS/);
        }
    );
});
