import { CLAUDE_CODE, NO_MODEL_MESSAGE } from '@factory-ai/core';
import { describe, expect, it } from 'vitest';
import { modelStanding } from '../src/routes/jobs/executor-usable.js';
import type { OrgRuntime } from '../src/orgs.js';

/**
 * Standing judges the env the claim will: an ambient key the selected connection replaces is not a model key, so a
 * connection beside settings that clear its own key is `missing` here exactly as the claim refuses it
 * (server/test-db/job-store.provider-connections.test.ts).
 */
const rt = (names: string[]): Pick<OrgRuntime, 'envVars' | 'modelRequired' | 'providerConnections'> =>
    ({
        modelRequired: true,
        envVars: { namesFor: async () => names },
        providerConnections: {
            forUser: async () => ({
                id: 'c',
                name: 'c',
                provider: 'anthropic',
                scope: 'personal',
                baseUrl: null,
                hasKey: true,
            }),
        },
    }) as unknown as Pick<OrgRuntime, 'envVars' | 'modelRequired' | 'providerConnections'>;

const subject = (config: unknown) => ({
    userId: 'u',
    repo: null,
    type: { state: 'known', type: CLAUDE_CODE } as const,
    config,
    connection: { id: 'c', scope: 'user' } as const,
});

describe('modelStanding with a selected connection', () => {
    it('is missing when the settings clear the connection key and only a replaced ambient key remains', async () => {
        expect(NO_MODEL_MESSAGE).toBeTruthy();
        expect(await modelStanding(rt(['OPENROUTER_API_KEY']), subject({ env: { ANTHROPIC_API_KEY: '' } }))).toBe(
            'missing'
        );
    });

    it('is ok when nothing clears the connection key', async () => {
        expect(await modelStanding(rt(['OPENROUTER_API_KEY']), subject({}))).toBe('ok');
    });
});
