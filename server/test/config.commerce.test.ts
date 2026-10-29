import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const DB = 'postgres://factory:factory@127.0.0.1:5432/factory_dev';
const NONE = { mode: 'none' } as const;
const BASE = { DATABASE_URL: DB };
const TOKEN = 'commerce-token-of-at-least-32-characters';
const URL_OK = 'https://commerce.example/';

describe('commerce config', () => {
    it('is off with no variables', () => {
        expect(loadConfig(BASE, NONE).commerce).toEqual({ enabled: false });
    });

    it('ignores COMMERCE_URL and COMMERCE_TOKEN while disabled', () => {
        const env = { ...BASE, COMMERCE_URL: 'not a url', COMMERCE_TOKEN: 'short' };
        expect(loadConfig(env, NONE).commerce).toEqual({ enabled: false });
    });

    it('is off with COMMERCE_ENABLED=false', () => {
        const env = { ...BASE, COMMERCE_ENABLED: 'false', COMMERCE_URL: URL_OK, COMMERCE_TOKEN: TOKEN };
        expect(loadConfig(env, NONE).commerce).toEqual({ enabled: false });
    });

    it('refuses COMMERCE_ENABLED=true without COMMERCE_URL, naming it', () => {
        const env = { ...BASE, COMMERCE_ENABLED: 'true', COMMERCE_TOKEN: TOKEN };
        expect(() => loadConfig(env, NONE)).toThrow(/COMMERCE_URL/);
    });

    it('refuses COMMERCE_ENABLED=true without COMMERCE_TOKEN, naming it', () => {
        const env = { ...BASE, COMMERCE_ENABLED: 'true', COMMERCE_URL: URL_OK };
        expect(() => loadConfig(env, NONE)).toThrow(/COMMERCE_TOKEN/);
    });

    it('refuses a COMMERCE_TOKEN under 32 characters without echoing it', () => {
        const short = 'x'.repeat(31);
        const env = { ...BASE, COMMERCE_ENABLED: 'true', COMMERCE_URL: URL_OK, COMMERCE_TOKEN: short };
        expect(() => loadConfig(env, NONE)).toThrow(/COMMERCE_TOKEN must be at least 32/);
        expect(() => loadConfig(env, NONE)).not.toThrow(new RegExp(short));
    });

    it.each(['ftp://commerce.example/', 'not a url'])('refuses the non-http(s) COMMERCE_URL %s', (url) => {
        const env = { ...BASE, COMMERCE_ENABLED: 'true', COMMERCE_URL: url, COMMERCE_TOKEN: TOKEN };
        expect(() => loadConfig(env, NONE)).toThrow(/COMMERCE_URL/);
    });

    it.each(['1', 'yes', 'TRUE'])('refuses COMMERCE_ENABLED=%s, naming it', (value) => {
        const env = { ...BASE, COMMERCE_ENABLED: value, COMMERCE_URL: URL_OK, COMMERCE_TOKEN: TOKEN };
        expect(() => loadConfig(env, NONE)).toThrow(/COMMERCE_ENABLED/);
    });

    it('enables with all three', () => {
        const env = { ...BASE, COMMERCE_ENABLED: 'true', COMMERCE_URL: URL_OK, COMMERCE_TOKEN: TOKEN };
        expect(loadConfig(env, NONE).commerce).toEqual({ enabled: true, url: URL_OK, token: TOKEN });
    });
});
