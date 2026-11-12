import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * opencode resolves a catalog model id against the live models.dev catalog at start-up and refuses
 * one the catalog marks deprecated, so a lane that names a catalog id fails when the catalog moves.
 * The lane declares its own model in the config instead; these pins keep every opencode config on it.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = readFileSync(join(ROOT, 'scripts/test-jobs.sh'), 'utf8');
/** The script with comment lines blanked, so prose naming a model is not read as config. */
const LANES = join(ROOT, 'scripts/lanes/jobs');
/** The dispatcher plus every phase body: the configs live in the phase files, the helper in the dispatcher. */
const ALL = [SCRIPT, ...readdirSync(LANES).map((name) => readFileSync(join(LANES, name), 'utf8'))].join('\n');
const CODE = ALL.replace(/^[ \t]*#.*$/gm, (comment) => ' '.repeat(comment.length));

const CONSTANT = /^LANE_OPENCODE_MODEL=([a-z0-9-]+)$/m;
const HELPER = /^lane_opencode_config\(\) \{[^\n]*\n[\s\S]*?\n\}\n/m;

describe('the opencode lane model', () => {
    it('declares one lane model, and no opencode config names a catalog id', () => {
        expect(CODE.match(new RegExp(CONSTANT.source, 'gm'))).toHaveLength(1);
        expect(CODE.match(/anthropic\/[a-z0-9.-]+/g)).toBeNull();
        expect(CODE).not.toContain('OPENCODE_CONFIG_CONTENT={');
    });

    it('routes every opencode config through lane_opencode_config', () => {
        expect(CODE.match(/OPENCODE_CONFIG_CONTENT=\$\(lane_opencode_config "/g)).toHaveLength(5);
        // The board-routed configs ride an executor row (PUT /api/workspace/executors).
        expect(CODE.match(/"\$\(lane_opencode_config "http:\/\/host\.docker\.internal:/g)).toHaveLength(2);
        expect(CODE).not.toContain('model: "anthropic/');
    });

    it('emits a config that declares its own model, so the catalog is never consulted for it', () => {
        const constant = SCRIPT.match(CONSTANT);
        const helper = SCRIPT.match(HELPER);
        if (!constant || !helper) {
            throw new Error('scripts/test-jobs.sh defines no LANE_OPENCODE_MODEL or lane_opencode_config()');
        }
        const out = execFileSync('bash', ['-c', `${constant[0]}\n${helper[0]}\nlane_opencode_config http://h:1/v1`], {
            encoding: 'utf8',
            timeout: 10_000,
        });
        const config = JSON.parse(out) as {
            model: string;
            provider: { anthropic: { options: Record<string, string>; models: Record<string, object> } };
        };
        const id = constant[1] as string;
        expect(config.model).toBe(`anthropic/${id}`);
        expect(config.provider.anthropic.options).toEqual({ baseURL: 'http://h:1/v1', apiKey: 'fake-key' });
        const entry = config.provider.anthropic.models[id];
        expect(entry).toBeTypeOf('object');
        // A declared model with a status the catalog uses to hide it is refused like a catalog one.
        expect(entry).not.toHaveProperty('status');
    });
});
