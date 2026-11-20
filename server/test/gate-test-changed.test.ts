import { describe, expect, it } from 'vitest';
import { FAKE_GIT, type GateRun, gateScript } from './fixtures/gate-script.js';

interface Fake {
    /** The selector's exit status (scripts/test-changed.mjs). */
    selectorStatus?: number;
    /** Whether `origin/<base>` resolves in the checkout before any fetch, and the fetch's status. */
    hasBase?: boolean;
    fetchStatus?: number;
    /** The core build's exit status (`npm run build -w core`). */
    buildStatus?: number;
    env?: Record<string, string>;
}

const run = gateScript('gate-test-changed.sh');

// The gate script against fake git, node and npm on PATH (server/test/fixtures/gate-script.ts).
const runGate = (fake: Fake, args: string[] = []): GateRun =>
    run({ node: 'exit "$FAKE_SELECTOR_STATUS"', git: FAKE_GIT, npm: 'exit "$FAKE_BUILD_STATUS"' }, args, {
        FAKE_SELECTOR_STATUS: String(fake.selectorStatus ?? 0),
        FAKE_HAS_BASE: fake.hasBase === false ? '0' : '1',
        FAKE_FETCH_STATUS: String(fake.fetchStatus ?? 0),
        FAKE_BUILD_STATUS: String(fake.buildStatus ?? 0),
        ...fake.env,
    });

const lane = (calls: string[]) => calls.filter((call) => !call.startsWith('git '));

describe('scripts/gate-test-changed.sh: the test and test:db gates run what the change reaches', () => {
    // test:changed has no pretest, and a fresh checkout has no core/dist for server and web to resolve.
    it('builds core, then hands the change since origin/main to test:changed', () => {
        const gate = runGate({});
        expect(gate.status).toBe(0);
        expect(lane(gate.calls)).toEqual(['npm run build -w core', 'node scripts/test-changed.mjs origin/main']);
    });

    // The claim's base (a batch task's target) is what the change is measured against.
    it('measures against the claim’s base branch: a project branch', () => {
        const gate = runGate({ env: { BELLOWS_BASE_BRANCH: 'project-x' } });
        expect(gate.status).toBe(0);
        expect(lane(gate.calls)).toEqual(['npm run build -w core', 'node scripts/test-changed.mjs origin/project-x']);
    });

    it('fetches the base when the checkout lacks it', () => {
        const gate = runGate({ hasBase: false, env: { BELLOWS_BASE_BRANCH: 'project-x' } });
        expect(gate.status).toBe(0);
        expect(gate.calls.filter((call) => call.startsWith('git fetch'))).toEqual([
            'git fetch --quiet origin +refs/heads/project-x:refs/remotes/origin/project-x',
        ]);
    });

    // An unconfirmed read never licenses a skip: no base means a failed gate, not "nothing changed".
    it('fails when the base cannot be fetched, running nothing', () => {
        const gate = runGate({ hasBase: false, fetchStatus: 128 });
        expect(gate.status).toBe(2);
        expect(gate.stderr).toContain('gate-test-changed: could not fetch origin/main');
        expect(lane(gate.calls)).toEqual([]);
    });

    it('fails when core does not build, before selecting', () => {
        const gate = runGate({ buildStatus: 1 });
        expect(gate.status).not.toBe(0);
        expect(lane(gate.calls)).toEqual(['npm run build -w core']);
    });

    // A selector that cannot answer fails the gate; it is never read as an empty selection.
    it('fails when the selector fails', () => {
        const gate = runGate({ selectorStatus: 1 });
        expect(gate.status).toBe(1);
        expect(lane(gate.calls)).toEqual(['npm run build -w core', 'node scripts/test-changed.mjs origin/main']);
    });

    // npm run test:db builds core itself (pretest:db).
    it('--db hands the change to the DB selector without building core', () => {
        const gate = runGate({}, ['--db']);
        expect(gate.status).toBe(0);
        expect(lane(gate.calls)).toEqual(['node scripts/test-changed.mjs origin/main --db']);
    });

    it('fails --db when the DB selector fails', () => {
        const gate = runGate({ selectorStatus: 1 }, ['--db']);
        expect(gate.status).toBe(1);
    });

    it.each([['--full'], ['--db', 'extra'], ['db'], ['']])(
        'refuses an unknown argument, running nothing: %j',
        (...args) => {
            const gate = runGate({}, args);
            expect(gate.status).toBe(2);
            expect(gate.stderr).toContain('usage: scripts/gate-test-changed.sh [--db]');
            expect(gate.calls).toEqual([]);
        }
    );
});
