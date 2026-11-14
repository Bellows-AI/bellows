import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const BASE = { DATABASE_URL: 'postgres://factory:factory@127.0.0.1:5432/factory_dev' };
const NONE = { mode: 'none' } as const;
const FREE = {
    PLAN_DEFAULT_MAX_RUNNING: '1',
    PLAN_DEFAULT_MAX_QUEUED: '10',
    PLAN_DEFAULT_MAX_WALL_SECONDS: '3600',
    PLAN_DEFAULT_MAX_TOKENS: '20000000',
    PLAN_DEFAULT_MAX_STORAGE_BYTES: '1073741824',
    PLAN_DEFAULT_MAX_RETENTION_DAYS: '7',
};

describe('plan default limits (the Free plan)', () => {
    it('are unlimited when unset on a self-hosted board', () => {
        expect(loadConfig(BASE, NONE).planDefaults).toEqual({});
    });

    it('read each limit from its own variable', () => {
        expect(loadConfig({ ...BASE, ...FREE }, NONE).planDefaults).toEqual({
            running: 1,
            queued: 10,
            wallSeconds: 3600,
            tokens: 20_000_000,
            storageBytes: 1_073_741_824,
            retentionDays: 7,
        });
    });

    it.each(Object.keys(FREE))('refuses a cloud boot without %s: no cloud organization is unlimited', (name) => {
        const env = { ...BASE, ...FREE, DEPLOYMENT_MODE: 'cloud', [name]: undefined };
        expect(() => loadConfig(env, NONE)).toThrow(new RegExp(`DEPLOYMENT_MODE=cloud requires ${name}`));
    });

    it('boots in cloud mode with every Free limit set', () => {
        expect(loadConfig({ ...BASE, ...FREE, DEPLOYMENT_MODE: 'cloud' }, NONE).planDefaults.running).toBe(1);
    });

    it.each(['0', '-1', '2.5', 'many'])('refuses %s, naming the variable', (raw) => {
        expect(() => loadConfig({ ...BASE, PLAN_DEFAULT_MAX_QUEUED: raw }, NONE)).toThrow(
            /PLAN_DEFAULT_MAX_QUEUED must be a positive integer/
        );
    });
});

describe('one retention knob per deployment', () => {
    it('keeps ARTIFACTS_RETENTION_DAYS on a self-hosted board with no plan window', () => {
        expect(loadConfig({ ...BASE, ARTIFACTS_RETENTION_DAYS: '30' }, NONE).artifacts.retentionDays).toBe(30);
    });

    it('refuses ARTIFACTS_RETENTION_DAYS in cloud mode: each org keeps its plan window', () => {
        const env = { ...BASE, ...FREE, DEPLOYMENT_MODE: 'cloud', ARTIFACTS_RETENTION_DAYS: '30' };
        expect(() => loadConfig(env, NONE)).toThrow(/cloud refuses ARTIFACTS_RETENTION_DAYS/);
    });

    it('refuses ARTIFACTS_RETENTION_DAYS beside PLAN_DEFAULT_MAX_RETENTION_DAYS on any board', () => {
        const env = { ...BASE, PLAN_DEFAULT_MAX_RETENTION_DAYS: '7', ARTIFACTS_RETENTION_DAYS: '30' };
        expect(() => loadConfig(env, NONE)).toThrow(/two retention windows/);
    });

    it('takes an empty ARTIFACTS_RETENTION_DAYS as unset, as the chart renders it', () => {
        const env = { ...BASE, ...FREE, DEPLOYMENT_MODE: 'cloud', ARTIFACTS_RETENTION_DAYS: '' };
        expect(loadConfig(env, NONE).planDefaults.retentionDays).toBe(7);
    });
});
