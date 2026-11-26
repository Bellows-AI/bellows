import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { guidedExecutorConfig } from '../src/executor-providers.js';
import { OPENCODE } from '../src/executors.js';

/*
 * The acceptance BEL-603 pins in a runner-shaped way: an OpenAI-compatible executor created through
 * the guided setup is one the real OpenCode CLI accepts. The lane runs the real images against a
 * scripted endpoint — scripts/fake-model-endpoint.mjs answers the OpenAI wire format in `--openai`
 * mode, and the scripts/test-jobs.sh phases drive a real task through it; what is pinned here,
 * offline, is the generated provider block registering in the real CLI, delivered the way the claim
 * delivers a profile's config, through `OPENCODE_CONFIG_CONTENT`, with the member's own key standing
 * where the endpoint's credential goes.
 */

const hasOpencode = (): boolean => {
    try {
        return spawnSync('sh', ['-c', 'command -v opencode'], { encoding: 'utf8' }).status === 0;
    } catch {
        return false;
    }
};

/** The model ids the real CLI registers from the configuration, run the way a runner runs it. */
const opencodeModels = (config: object): { stdout: string; stderr: string } => {
    const dataHome = mkdtempSync(join(tmpdir(), 'opencode-data-'));
    const configHome = mkdtempSync(join(tmpdir(), 'opencode-config-'));
    // Hermetic and runner-shaped: the generated configuration rides `OPENCODE_CONFIG_CONTENT` — the
    // one channel the claim delivers a profile's config through — over whatever OPENCODE_*
    // environment the host carries (this sandbox's own agent config included: its providers must
    // not answer for the endpoint's model). The provider catalog fetch is disabled outright
    // (`OPENCODE_DISABLE_MODELS_FETCH`): the config declares its own provider and model, so nothing
    // in the live catalog is consulted for it — the lane's rule in scripts/test-jobs.sh — and the
    // command never waits on the network.
    const env: Record<string, string> = {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        TMPDIR: process.env.TMPDIR ?? '',
        OPENCODE_DISABLE_MODELS_FETCH: '1',
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        XDG_CONFIG_HOME: configHome,
        XDG_DATA_HOME: dataHome,
    };
    try {
        const run = spawnSync('opencode', ['models'], {
            cwd: dataHome,
            encoding: 'utf8',
            timeout: 60_000,
            env,
        });
        return { stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
    } finally {
        rmSync(configHome, { recursive: true, force: true });
        rmSync(dataHome, { recursive: true, force: true });
    }
};

describe.skipIf(!hasOpencode())('the generated OpenAI-compatible config registers in the real OpenCode CLI', () => {
    it('lists the endpoint provider and its model from the guided config alone', () => {
        const config = guidedExecutorConfig({
            provider: 'openai-compatible',
            agent: OPENCODE,
            model: 'test-model',
            key: 'sk-member-test-key',
            baseUrl: 'https://vllm.internal:8000/v1',
        });

        const run = opencodeModels(config);
        // The generated id is the endpoint host, slugified; the CLI registers provider/model from it.
        expect(run.stdout, run.stderr.slice(-300)).toContain('vllm-internal/test-model');
    });
});
