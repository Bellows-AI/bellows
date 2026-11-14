import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAuthStore, type AuthStore } from '../src/auth/store.js';
import { randomGithubId } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * The docker lane's mcp phase (scripts/lanes/jobs/mcp.sh) seeds its member's tracked repository with psql BEFORE the
 * member has signed in, so nothing has created that organization yet. The SQL is read from the script itself, so a
 * seed the schema refuses (a foreign key, a policy) fails here in seconds instead of stopping the lane.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const SCRIPT = new URL('../../scripts/lanes/jobs/mcp.sh', import.meta.url);
const SMOKE_REPO = 'factory-smoke/demo';

const script = readFileSync(SCRIPT, 'utf8');
const MCP_ORG = /^MCP_ORG=(\S+)/m.exec(script)?.[1] ?? '';

/** Every `psql … -c "<sql>"` the phase runs, with the shell variables it names substituted. */
const seeds = [...script.matchAll(/psql[^\n]*-c \\\n\s*"([^"]*)"/g)].map((m) =>
    (m[1] ?? '').replaceAll('$MCP_ORG', MCP_ORG).replaceAll('$SMOKE_REPO', SMOKE_REPO)
);

const db = useTestDb();
let store: AuthStore;

const seededRepos = async (): Promise<string[]> =>
    (await db.sql<{ repo: string }[]>`select repo from session_branch where org_id = ${MCP_ORG}`).map((r) => r.repo);

beforeAll(() => {
    if (enabled) store = createAuthStore({ sql: db.sql });
});

describe('the mcp phase seed — script', () => {
    it('names its organization and runs at least one seed statement', () => {
        expect(MCP_ORG).toMatch(/^\d+$/);
        expect(seeds.length).toBeGreaterThan(0);
        for (const seed of seeds) expect(seed).not.toMatch(/\$[A-Z_]/);
    });
});

describe.skipIf(!enabled)('the mcp phase seed — database', () => {
    it('applies to a migrated schema before the member signs in, and the sign-in still materializes the org', async () => {
        for (const seed of seeds) await db.sql.unsafe(seed);
        expect(await seededRepos()).toContain(SMOKE_REPO);

        // The board's own sign-in upserts the installation's organization over the seeded row.
        const login = 'lane-mcp-member';
        const identity = { githubUserId: randomGithubId(), login, displayName: login, avatarUrl: null };
        await store.signIn(identity, MCP_ORG, [{ id: MCP_ORG, name: 'e2e-site' }]);
        expect(await store.findOrg(MCP_ORG)).toEqual({ id: MCP_ORG, name: 'e2e-site' });
        expect(await seededRepos()).toContain(SMOKE_REPO);
    });
});
