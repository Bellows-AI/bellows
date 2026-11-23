import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { concurrentIndexes } from '../src/db/migrate.js';

const DIR = new URL('../migrations/', import.meta.url);

/** `migrations/concurrent/*.sql` run outside the schema transaction: each statement must be a concurrent index build. */
describe('the concurrent index migrations', () => {
    it('ships 167 and reads as one named index build per statement', () => {
        expect(readdirSync(new URL('concurrent/', DIR))).toContain('167_repo_ref_indexes.sql');
        const names = concurrentIndexes(DIR).map((index) => index.name);
        expect(names).toEqual(
            expect.arrayContaining([
                'pr_merge_ref_uk',
                'pr_follow_ref_uk',
                'batch_merge_ref_slot_idx',
                'job_admission_repo_ref_uk',
            ])
        );
        expect(new Set(names).size).toBe(names.length);
    });
});
