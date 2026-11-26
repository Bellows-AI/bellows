import { describe, expect, it } from 'vitest';
import { withoutForgeTokens } from '../src/db/jobs/job-store-claim-executor.js';

/**
 * The claim env's GitHub rule, pinned offline for the same reason `stackEnv` is: a rule this
 * load-bearing must not live only where a database is. No member GitHub token reaches a runner —
 * GitHub is the App's, obtained from the board by the runner's helper (docs/connections.md).
 */
describe('withoutForgeTokens', () => {
    it('drops every forge credential name, whatever scope resolved them', () => {
        expect(
            withoutForgeTokens({
                GITHUB_TOKEN: 'ghp_member',
                GH_TOKEN: 'ghp_other',
                GITLAB_TOKEN: 'glpat_member',
                GL_TOKEN: 'glpat_other',
                CI_JOB_TOKEN: 'job',
                X: 'y',
            })
        ).toEqual({ X: 'y' });
    });

    it('leaves every other name untouched', () => {
        expect(withoutForgeTokens({ X: 'y', GITHUB_APP_HINT: 'z' })).toEqual({ X: 'y', GITHUB_APP_HINT: 'z' });
    });

    it('carries no environment when nothing resolved', () => {
        expect(withoutForgeTokens(undefined)).toBeUndefined();
    });
});
