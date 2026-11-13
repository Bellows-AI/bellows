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
