import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { useTestDb } from './harness.js';
import { testOrg } from './fixtures.js';

const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const db = useTestDb({ orgs: [ORG] });
const MIGRATION = readFileSync(new URL('../migrations/082_pr_follow.sql', import.meta.url), 'utf8');

describe.skipIf(!enabled)('082 on a board with waits already open (issue #831)', () => {
    // A wait opened before the follower existed may have missed activity while nothing read its PR:
    // its observation boundary is its first entry, never the migration's own clock.
    it('backfills a wait from its first entry, not from the migration time', async () => {
        const { sql } = db;
        const root = randomUUID();
        await sql`
            insert into workflow_wait (org_id, root_job_id, reason, repo, pr_number, created_at, active_at)
            values (${ORG}, ${root}, 'review', 'acme/widgets', 7,
                    now() - interval '2 hours', now() - interval '10 minutes')
        `;
        // The column as it stood before 082: absent, so unset on every existing row.
        await sql`alter table workflow_wait alter column observed_since drop not null`;
        await sql`update workflow_wait set observed_since = null`;
        await sql.unsafe(MIGRATION);

        const [row] = await sql<{ backfilled: boolean }[]>`
            select observed_since = created_at as backfilled from workflow_wait where root_job_id = ${root}
        `;
        expect(row!.backfilled).toBe(true);
    });
});
