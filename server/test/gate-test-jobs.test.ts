import { describe, expect, it } from 'vitest';
import { FAKE_GIT, type GateRun, gateScript } from './fixtures/gate-script.js';

interface Fake {
    /** What the path-to-phase map prints on stdout, and its exit status. */
    map?: string;
    mapStatus?: number;
    /** Whether `origin/<base>` resolves in the checkout before any fetch, and the fetch's status. */
    hasBase?: boolean;
    fetchStatus?: number;
    makeStatus?: number;
    env?: Record<string, string>;
}

const run = gateScript('gate-test-jobs.sh');

// The gate script against fake git, node, make and npm on PATH (server/test/fixtures/gate-script.ts).
const runGate = (fake: Fake): GateRun =>
    run(
        {
            node: `printf '%s' "$FAKE_MAP"\nexit "$FAKE_MAP_STATUS"`,
            git: FAKE_GIT,
            make: 'exit "$FAKE_MAKE_STATUS"',
            npm: 'exit 0',
        },
        [],
        {
            FAKE_MAP: fake.map ?? '',
            FAKE_MAP_STATUS: String(fake.mapStatus ?? 0),
            FAKE_HAS_BASE: fake.hasBase === false ? '0' : '1',
            FAKE_FETCH_STATUS: String(fake.fetchStatus ?? 0),
            FAKE_MAKE_STATUS: String(fake.makeStatus ?? 0),
            ...fake.env,
        }
    );

const lane = (calls: string[]) => calls.filter((call) => !call.startsWith('git '));

describe('scripts/gate-test-jobs.sh: the test:jobs gate runs the mapped phases only', () => {
    // A change no jobs phase executes ends at the map, before the runner images are built.
    it('passes on an empty selection without building the runner images', () => {
        const run = runGate({ map: '' });
        expect(run.status).toBe(0);
        expect(run.stdout).toContain('selected no phase; nothing to run');
        expect(lane(run.calls)).toEqual(['node scripts/test-jobs-changed.mjs origin/main']);
    });

    // An unconfirmed read never licenses a skip: a map that cannot answer fails the gate.
    it('fails when the map fails, and runs nothing after it', () => {
        const run = runGate({ map: 'board', mapStatus: 2 });
        expect(run.status).not.toBe(0);
        expect(lane(run.calls)).toEqual(['node scripts/test-jobs-changed.mjs origin/main']);
    });

    it.each(['board,,driver', ',board', 'board driver', 'board;rm', 'Board'])(
        'fails on a selection the map cannot have printed: %j',
        (map) => {
            const run = runGate({ map });
            expect(run.status).not.toBe(0);
            expect(lane(run.calls)).toEqual(['node scripts/test-jobs-changed.mjs origin/main']);
        }
    );

    it('builds the runner images, then runs the listed phases', () => {
        const run = runGate({ map: 'board,services' });
        expect(run.status).toBe(0);
        expect(lane(run.calls)).toEqual([
            'node scripts/test-jobs-changed.mjs origin/main',
            'make runners',
            'npm run test:jobs -- --phase board,services',
        ]);
    });

    it('runs the whole lane when the map says full', () => {
        const run = runGate({ map: 'full' });
        expect(run.status).toBe(0);
        expect(lane(run.calls)).toEqual([
            'node scripts/test-jobs-changed.mjs origin/main',
            'make runners',
            'npm run test:jobs',
        ]);
    });

    it('fails when the runner images do not build, before the lane', () => {
        const run = runGate({ map: 'board', makeStatus: 3 });
        expect(run.status).not.toBe(0);
        expect(lane(run.calls)).toEqual(['node scripts/test-jobs-changed.mjs origin/main', 'make runners']);
    });

    // The claim's base (a batch task's target) is what the change is measured against.
    it('measures the change against the claim’s base branch', () => {
        const run = runGate({ map: '', env: { BELLOWS_BASE_BRANCH: 'release/2' } });
        expect(run.status).toBe(0);
        expect(lane(run.calls)).toEqual(['node scripts/test-jobs-changed.mjs origin/release/2']);
    });

    it('fetches the base when the checkout lacks it', () => {
        const run = runGate({ map: '', hasBase: false, env: { BELLOWS_BASE_BRANCH: 'release/2' } });
        expect(run.status).toBe(0);
        expect(run.calls.filter((call) => call.startsWith('git fetch'))).toEqual([
            'git fetch --quiet origin +refs/heads/release/2:refs/remotes/origin/release/2',
        ]);
    });

    it('fails when the base cannot be fetched, without mapping', () => {
        const run = runGate({ map: 'board', hasBase: false, fetchStatus: 128 });
        expect(run.status).not.toBe(0);
        expect(lane(run.calls)).toEqual([]);
    });
});
