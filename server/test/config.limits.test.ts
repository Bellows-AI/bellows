import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { DEFAULT_REQUEST_LIMITS, DEFAULT_STATEMENT_TIMEOUT_MS } from '../src/config-limits.js';

const BASE = {
    DATABASE_URL: 'postgres://factory:factory@127.0.0.1:5432/factory_dev',
    GITHUB_APP_ID: '123',
    GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\nshape-checked-only\n-----END RSA PRIVATE KEY-----',
};

const load = (env: NodeJS.ProcessEnv) => loadConfig({ ...BASE, ...env });

describe('TRUSTED_PROXIES', () => {
    it('trusts no proxy when unset or empty', () => {
        expect(load({}).trustedProxies).toEqual([]);
        expect(load({ TRUSTED_PROXIES: ' ' }).trustedProxies).toEqual([]);
    });

    it('reads a comma-separated list of addresses and CIDRs', () => {
        expect(load({ TRUSTED_PROXIES: '10.0.0.0/8, 192.168.1.1,fd00::/8' }).trustedProxies).toEqual([
            '10.0.0.0/8',
            '192.168.1.1',
            'fd00::/8',
        ]);
    });

    it.each(['*', 'true', '10.0.0.0/33', 'fd00::/129', 'proxy.internal', '10.0.0.0/', '10.0.0.0/8/1'])(
        'refuses %s, naming the variable',
        (raw) => {
            expect(() => load({ TRUSTED_PROXIES: raw })).toThrow(/TRUSTED_PROXIES/);
        }
    );
});

describe('the request limits', () => {
    it('defaults every limit', () => {
        expect(load({}).requestLimits).toEqual(DEFAULT_REQUEST_LIMITS);
        expect(load({}).dbStatementTimeoutMs).toBe(DEFAULT_STATEMENT_TIMEOUT_MS);
    });

    it('reads each from its variable', () => {
        const config = load({
            RATE_LIMIT_PER_CREDENTIAL: '5',
            RATE_LIMIT_PER_ORG: '7',
            MCP_STREAMS_PER_ORG: '3',
            DB_STATEMENT_TIMEOUT_MS: '1500',
        });
        expect(config.requestLimits).toEqual({
            ...DEFAULT_REQUEST_LIMITS,
            perCredential: 5,
            perOrg: 7,
            streamsPerOrg: 3,
        });
        expect(config.dbStatementTimeoutMs).toBe(1500);
    });

    it.each(['RATE_LIMIT_PER_CREDENTIAL', 'RATE_LIMIT_PER_ORG', 'MCP_STREAMS_PER_ORG', 'DB_STATEMENT_TIMEOUT_MS'])(
        'refuses a %s that is not a positive integer: zero would mean no limit',
        (name) => {
            expect(() => load({ [name]: '0' })).toThrow(new RegExp(name));
            expect(() => load({ [name]: 'lots' })).toThrow(new RegExp(name));
        }
    );
});
