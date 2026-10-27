import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { replaceTrackedRepos, trackedRepos } from '../src/db/tracked-repos.js';
import { createRepoSource, type RepoSource } from '../src/github/repo-source.js';
import { useTestDb } from './harness.js';
import { testOrg } from './fixtures.js';

const enabled = Boolean(process.env.DATABASE_URL);

const ORG = testOrg();
const db = useTestDb({ orgs: [ORG] });
let sql: Sql;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
});

const names = async (source: RepoSource) => (await source.list()).map((repo) => `${repo.owner}/${repo.name}`);

/** One dashboard replica's source: its own cache, the shared database's allowlist. */
const replica = (allowlist: () => Promise<readonly string[]> = () => trackedRepos({ sql, orgId: ORG })) =>
    createRepoSource({ stored: async () => ['acme/web', 'acme/other'], allowlist });

describe.skipIf(!enabled)('the repo list across dashboard replicas', () => {
    it('a narrowed allowlist reaches a replica that did not handle the write, with no invalidate', async () => {
        const writer = replica();
        const other = replica();
        expect(await names(writer)).toEqual(['acme/web', 'acme/other']);
        expect(await names(other)).toEqual(['acme/web', 'acme/other']);

        // The onboarding write lands on one replica, which invalidates only its own cache.
        await replaceTrackedRepos({ sql, orgId: ORG, repos: ['acme/web'] });
        writer.invalidate();

        expect(await names(writer)).toEqual(['acme/web']);
        expect(await names(other)).toEqual(['acme/web']);
        expect(other.snapshotNames()).toEqual(['acme/web']);
    });

    it('a failed allowlist read serves the last narrowed list, never the full listing', async () => {
        await replaceTrackedRepos({ sql, orgId: ORG, repos: ['acme/web'] });
        let fail = false;
        const source = replica(async () => {
            if (fail) throw new Error('allowlist read failed');
            return trackedRepos({ sql, orgId: ORG });
        });
        expect(await names(source)).toEqual(['acme/web']);

        fail = true;
        expect(await names(source)).toEqual(['acme/web']);
        expect(source.lastError()).toBe('allowlist read failed');

        fail = false;
        expect(await names(source)).toEqual(['acme/web']);
        expect(source.lastError()).toBeNull();
    });

    it('an allowlist that fails before any narrowed read reports nothing and an error, not the full listing', async () => {
        const source = replica(async () => {
            throw new Error('allowlist read failed');
        });
        expect(await names(source)).toEqual([]);
        expect(source.lastError()).toBe('allowlist read failed');
    });
});
