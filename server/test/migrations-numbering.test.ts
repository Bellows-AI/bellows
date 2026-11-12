import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { duplicatePrefixes } from '../src/db/migrate.js';

// The ledger key is the filename, so a rename re-applies the file: these pairs are frozen.
const FROZEN = [
    '023_drop_pull_requests.sql',
    '023_job_stopped.sql',
    '024_access_tokens.sql',
    '024_job_wall_clock.sql',
    '025_job_actors.sql',
    '025_user_repo_access.sql',
    '028_job_summary.sql',
    '028_org_installations.sql',
    '030_signin_selection.sql',
    '030_workflow_params.sql',
    '044_job_failure_kind.sql',
    '044_user_repo_purge.sql',
    '045_job_worktree_reclaimed.sql',
    '045_workflow_wait_user_control.sql',
    '057_drop_seeded_fix_issue.sql',
    '057_job_claim_seq.sql',
    '072_github_env_reserved.sql',
    '072_job_settle_receipts.sql',
    '080_drop_user_repo.sql',
    '080_job_phase_checkpoints.sql',
];

describe('migration numbering', () => {
    it('finds a prefix shared by two files', () => {
        expect(duplicatePrefixes(['001_a.sql', '002_b.sql', '002_c.sql', '003_d.sql'])).toEqual(['002']);
        expect(duplicatePrefixes(['001_a.sql', '002_b.sql'])).toEqual([]);
    });

    it('ships exactly the frozen duplicate pairs, so a new file takes a new number', () => {
        const names = readdirSync(new URL('../migrations/', import.meta.url)).filter((n) => n.endsWith('.sql'));
        const dupes = new Set(duplicatePrefixes(names));
        expect(names.filter((n) => dupes.has(n.split('_')[0] as string))).toEqual(FROZEN);
    });
});
