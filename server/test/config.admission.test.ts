import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const BASE = { DATABASE_URL: 'postgres://factory:factory@127.0.0.1:5432/factory_dev' };
const NONE = { mode: 'none' } as const;

describe('admission budgets (issue #831)', () => {
    it('are unlimited when unset', () => {
        expect(loadConfig(BASE, NONE).admission).toEqual({});
    });

    it('read each scope from its own variable', () => {
        const env = {
            ...BASE,
            ADMISSION_MAX_RUNNING: '20',
            ADMISSION_MAX_RUNNING_PER_ORG: '8',
            ADMISSION_MAX_RUNNING_PER_REPO: '3',
        };
        expect(loadConfig(env, NONE).admission).toEqual({ global: 20, org: 8, repo: 3 });
    });

    it.each(['0', '-1', '2.5', 'many'])('refuses %s, naming the variable', (raw) => {
        expect(() => loadConfig({ ...BASE, ADMISSION_MAX_RUNNING_PER_REPO: raw }, NONE)).toThrow(
            /ADMISSION_MAX_RUNNING_PER_REPO must be a positive integer/
        );
    });
});
