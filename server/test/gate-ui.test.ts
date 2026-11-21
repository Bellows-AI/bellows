import { describe, expect, it } from 'vitest';
import { gateScript } from './fixtures/gate-script.js';

interface Fake {
    /** The databases `psql` reports as existing. */
    existing?: string[];
    /** The build's exit status (`npm run build`). */
    buildStatus?: number;
    env?: Record<string, string>;
}

const run = gateScript('gate-ui.sh');

// A fake psql answers the existence probe from $FAKE_DBS; every other call succeeds.
const FAKE_PSQL = `case "$*" in *"from pg_database"*) for db in $FAKE_DBS; do case "$*" in *"'$db'"*) echo 1 ;; esac; done ;; esac`;

const runGate = (fake: Fake): ReturnType<typeof run> =>
    run(
        {
            psql: FAKE_PSQL,
            npm: 'exit "$FAKE_BUILD_STATUS"',
            npx: 'echo "E2E_DB_HOST=$E2E_DB_HOST" >&2',
        },
        [],
        {
            FAKE_DBS: (fake.existing ?? []).join(' '),
            FAKE_BUILD_STATUS: String(fake.buildStatus ?? 0),
            ...fake.env,
        }
    );

const lane = (calls: string[]) => calls.filter((call) => !call.startsWith('psql '));
const creates = (calls: string[]) => calls.filter((call) => call.includes('create database'));

describe('scripts/gate-ui.sh: the ui gate runs verify:ui against the declared postgres', () => {
    // playwright.config.ts names both databases; e2e/reset-db.mjs truncates but never creates.
    it('creates both e2e databases on a fresh service, then installs, builds and runs the whole suite', () => {
        const gate = runGate({});
        expect(gate.status).toBe(0);
        expect(creates(gate.calls)).toEqual([
            'psql postgres://factory:factory@postgres:5432/postgres -v ON_ERROR_STOP=1 -q -c create database factory_e2e',
            'psql postgres://factory:factory@postgres:5432/postgres -v ON_ERROR_STOP=1 -q -c create database factory_auth_e2e',
        ]);
        expect(lane(gate.calls)).toEqual(['npx playwright install chromium', 'npm run build', 'npx playwright test']);
        expect(gate.stderr).toContain('E2E_DB_HOST=postgres');
    });

    // The agent runs the gate again and again on one service: a second run must not fail on create.
    it('creates only the databases the service lacks', () => {
        expect(creates(runGate({ existing: ['factory_e2e', 'factory_auth_e2e'] }).calls)).toEqual([]);
        expect(creates(runGate({ existing: ['factory_e2e'] }).calls)).toEqual([
            'psql postgres://factory:factory@postgres:5432/postgres -v ON_ERROR_STOP=1 -q -c create database factory_auth_e2e',
        ]);
    });

    // The agent's ad-hoc run narrows to the specs its change touches; a glob is passed through, not expanded.
    it('hands GATE_FILTER to playwright as its spec arguments', () => {
        const gate = runGate({ env: { GATE_FILTER: 'e2e/task-detail.spec.ts e2e/*.spec.ts' } });
        expect(gate.status).toBe(0);
        expect(lane(gate.calls).at(-1)).toBe('npx playwright test e2e/task-detail.spec.ts e2e/*.spec.ts');
    });

    it('fails on a failed build, before any spec runs', () => {
        const gate = runGate({ buildStatus: 1 });
        expect(gate.status).not.toBe(0);
        expect(lane(gate.calls)).toEqual(['npx playwright install chromium', 'npm run build']);
    });
});
