import { describe, expect, it } from 'vitest';
import type { ModelSetupView } from '../src/api/useModelSetup.js';
import type { WorkspacePayload } from '../src/api/useWorkspace.js';
import { showNoModel } from '../src/onboarding/no-model.js';

/** "No model yet" only where a task could not run: cloud on no key, self-hosted on no key and no default at all. */

const NONE: ModelSetupView = { platform: false, org: null, personal: null, effective: null };
const KEYED: ModelSetupView = { ...NONE, effective: 'org' };
/** A default executor on a connection: effective with no environment key and no agent default anywhere. */
const EXECUTOR: ModelSetupView = {
    ...NONE,
    effective: 'executor',
    selected: {
        scope: 'org',
        executorId: 'executor-1',
        name: 'Claude',
        agentType: 'claude-code',
        model: 'claude-sonnet-4-5',
        suspended: false,
        connection: { id: 'connection-1', name: 'Anthropic', provider: 'anthropic', scope: 'org', baseUrl: null },
    },
};
const BARE: WorkspacePayload = { executors: [], orgExecutors: [], defaultExecutor: null, agentDefault: null };
const PROFILE: WorkspacePayload = { ...BARE, defaultExecutor: { scope: 'user', name: 'mine' } };
const AGENT: WorkspacePayload = { ...BARE, agentDefault: { agentType: 'claude-code', model: 'm', from: 'org' } };

const ok = <T>(data: T) => ({ data, error: null });
const loading = { data: null, error: null };
const failed = { data: null, error: 'down' };

describe('showNoModel', () => {
    it('never on an unconfirmed model read', () => {
        for (const modelSetup of [loading, failed, { data: NONE, error: 'stale' }]) {
            expect(showNoModel({ mode: 'cloud', modelSetup, workspace: ok(BARE) })).toBe(false);
        }
    });

    it('never when a key or the platform resolves', () => {
        expect(showNoModel({ mode: 'cloud', modelSetup: ok(KEYED), workspace: ok(BARE) })).toBe(false);
        expect(showNoModel({ mode: 'self-hosted', modelSetup: ok(KEYED), workspace: ok(BARE) })).toBe(false);
    });

    it('never when a default executor resolves, with no env copy of its key, in cloud or self-hosted', () => {
        for (const mode of ['cloud', 'self-hosted'] as const) {
            expect(showNoModel({ mode, modelSetup: ok(EXECUTOR), workspace: ok(BARE) })).toBe(false);
        }
    });

    it('a suspended default executor is not effective: the read says null and cloud shows the warning', () => {
        const suspended: ModelSetupView = { ...EXECUTOR, effective: null };
        expect(showNoModel({ mode: 'cloud', modelSetup: ok(suspended), workspace: ok(BARE) })).toBe(true);
    });

    it('cloud: on a confirmed effective null, whatever the workspace holds', () => {
        expect(showNoModel({ mode: 'cloud', modelSetup: ok(NONE), workspace: ok(PROFILE) })).toBe(true);
        expect(showNoModel({ mode: 'cloud', modelSetup: ok(NONE), workspace: loading })).toBe(true);
    });

    it('self-hosted: only when no profile and no agent default either', () => {
        expect(showNoModel({ mode: 'self-hosted', modelSetup: ok(NONE), workspace: ok(BARE) })).toBe(true);
        expect(showNoModel({ mode: 'self-hosted', modelSetup: ok(NONE), workspace: ok(PROFILE) })).toBe(false);
        expect(showNoModel({ mode: 'self-hosted', modelSetup: ok(NONE), workspace: ok(AGENT) })).toBe(false);
    });

    it('self-hosted: never on an unconfirmed workspace read', () => {
        expect(showNoModel({ mode: 'self-hosted', modelSetup: ok(NONE), workspace: loading })).toBe(false);
        expect(showNoModel({ mode: 'self-hosted', modelSetup: ok(NONE), workspace: failed })).toBe(false);
    });

    it('never while the deployment mode is unknown', () => {
        expect(showNoModel({ mode: null, modelSetup: ok(NONE), workspace: ok(BARE) })).toBe(false);
    });
});
