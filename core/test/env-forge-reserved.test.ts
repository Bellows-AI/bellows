import { describe, expect, it } from 'vitest';
import { FORGE_ENV_NAMES, isReservedEnvName } from '../src/env.js';

describe('the forge credential names are reserved', () => {
    it('names GitHub’s and GitLab’s, in every scope', () => {
        expect([...FORGE_ENV_NAMES].sort()).toEqual([
            'CI_JOB_TOKEN',
            'GH_TOKEN',
            'GITHUB_TOKEN',
            'GITLAB_TOKEN',
            'GL_TOKEN',
        ]);
        for (const name of FORGE_ENV_NAMES) expect(isReservedEnvName(name)).toBe(true);
    });
});
