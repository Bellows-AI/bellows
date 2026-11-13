import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const BASE = { DATABASE_URL: 'postgres://factory:factory@127.0.0.1:5432/factory_dev' };
const NONE = { mode: 'none' } as const;
const CLOUD = {
    ...BASE,
    DEPLOYMENT_MODE: 'cloud',
    PLAN_DEFAULT_MAX_RUNNING: '1',
    PLAN_DEFAULT_MAX_QUEUED: '10',
    PLAN_DEFAULT_MAX_WALL_SECONDS: '3600',
};

describe('the operator principal (OPERATOR_GITHUB_IDS)', () => {
    it('is nobody when unset or empty', () => {
        expect(loadConfig(CLOUD, NONE).operatorGithubIds).toEqual([]);
        expect(loadConfig({ ...CLOUD, OPERATOR_GITHUB_IDS: '' }, NONE).operatorGithubIds).toEqual([]);
        expect(loadConfig(BASE, NONE).operatorGithubIds).toEqual([]);
    });

    it('reads a comma-separated list of numeric GitHub user ids', () => {
        expect(loadConfig({ ...CLOUD, OPERATOR_GITHUB_IDS: '101, 202,303' }, NONE).operatorGithubIds).toEqual([
            101, 202, 303,
        ]);
    });

    it.each(['octocat', '12a', '0', '-5', '1,,2'])('refuses %s, naming the variable', (raw) => {
        expect(() => loadConfig({ ...CLOUD, OPERATOR_GITHUB_IDS: raw }, NONE)).toThrow(
            /OPERATOR_GITHUB_IDS must be a comma-separated list of GitHub user ids/
        );
    });

    it('refuses a self-hosted board with an operator: only cloud mode reads an organization status', () => {
        expect(() => loadConfig({ ...BASE, OPERATOR_GITHUB_IDS: '101' }, NONE)).toThrow(
            /OPERATOR_GITHUB_IDS needs DEPLOYMENT_MODE=cloud/
        );
    });
});
