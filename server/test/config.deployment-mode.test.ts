import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const BASE = {
    DATABASE_URL: 'postgres://factory:factory@127.0.0.1:5432/factory_dev',
    GITHUB_APP_ID: '123',
    GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\nshape-checked-only\n-----END RSA PRIVATE KEY-----',
};

const load = (env: NodeJS.ProcessEnv) => loadConfig({ ...BASE, ...env });

// A cloud board boots only with the Free plan's limits (config.plan-defaults.test.ts).
const free = {
    PLAN_DEFAULT_MAX_RUNNING: '1',
    PLAN_DEFAULT_MAX_QUEUED: '10',
    PLAN_DEFAULT_MAX_WALL_SECONDS: '3600',
    PLAN_DEFAULT_MAX_TOKENS: '1000000',
    PLAN_DEFAULT_MAX_STORAGE_BYTES: '1048576',
    PLAN_DEFAULT_MAX_RETENTION_DAYS: '7',
};
const cloud = (ids?: string) =>
    load({ DEPLOYMENT_MODE: 'cloud', ...free, ...(ids === undefined ? {} : { CLOUD_SUBSCRIPTION_ORG_IDS: ids }) });

describe('DEPLOYMENT_MODE', () => {
    it('is self-hosted with no variable', () => {
        expect(load({}).deploymentMode).toBe('self-hosted');
    });

    it('accepts self-hosted and cloud', () => {
        expect(load({ DEPLOYMENT_MODE: 'self-hosted' }).deploymentMode).toBe('self-hosted');
        expect(load({ DEPLOYMENT_MODE: 'cloud', ...free }).deploymentMode).toBe('cloud');
    });

    it('refuses any other value, naming the variable', () => {
        expect(() => load({ DEPLOYMENT_MODE: 'Cloud' })).toThrow(/DEPLOYMENT_MODE must be "self-hosted" or "cloud"/);
        expect(() => load({ DEPLOYMENT_MODE: '' })).toThrow(/DEPLOYMENT_MODE/);
    });
});

describe('CLOUD_SUBSCRIPTION_ORG_IDS', () => {
    it('is empty unset or blank', () => {
        expect(cloud().cloudSubscriptionOrgIds).toEqual(new Set());
        expect(cloud('').cloudSubscriptionOrgIds).toEqual(new Set());
        expect(cloud('   ').cloudSubscriptionOrgIds).toEqual(new Set());
    });

    it('reads a comma-separated list, trimming each id and collapsing duplicates', () => {
        expect(cloud(' org-a , org-b ').cloudSubscriptionOrgIds).toEqual(new Set(['org-a', 'org-b']));
        expect(cloud('org-a,org-a').cloudSubscriptionOrgIds).toEqual(new Set(['org-a']));
    });

    it('refuses an empty id or one with whitespace, naming the variable but no listed id', () => {
        expect(() => cloud('org-a,,org-b')).toThrow(/CLOUD_SUBSCRIPTION_ORG_IDS/);
        expect(() => cloud('org-a,')).toThrow(/CLOUD_SUBSCRIPTION_ORG_IDS/);
        expect(() => cloud('org-a b')).toThrow(/CLOUD_SUBSCRIPTION_ORG_IDS/);
        expect(() => cloud('org-listed,org-a b')).toThrow(/^(?![\s\S]*org-listed)[\s\S]*CLOUD_SUBSCRIPTION_ORG_IDS/);
    });

    it('never refuses a self-hosted boot, where the list is ignored', () => {
        expect(load({ CLOUD_SUBSCRIPTION_ORG_IDS: 'org-a,org-b' }).cloudSubscriptionOrgIds).toEqual(
            new Set(['org-a', 'org-b'])
        );
        expect(() => load({ CLOUD_SUBSCRIPTION_ORG_IDS: 'org-a,,org b' })).not.toThrow();
    });
});
