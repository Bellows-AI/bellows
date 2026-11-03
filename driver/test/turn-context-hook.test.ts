import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT as ROOT, readRepoFile as read } from './fixtures/repo-files.js';

/*
 * Issue #509: the claim's per-node turn context reaches Claude Code through the baked
 * UserPromptSubmit hook, never the system prompt (a per-node byte there re-writes a resumed
 * session's history to the prompt cache) and never the `-p` text (a `/skill` command must stay
 * first to expand). The driver puts it in FACTORY_TURN_CONTEXT (runner-plan.ts); this pins the
 * file the image ships.
 */
const HOOK = join(ROOT, 'docker/claude-executor/turn-context-hook.cjs');

const runHook = (env: Record<string, string>, cwd?: string): string =>
    execFileSync('node', [HOOK], {
        env: { PATH: process.env.PATH ?? '', ...env },
        input: '{}',
        ...(cwd ? { cwd } : {}),
    }).toString();

describe('the turn-context hook', () => {
    it('adds the turn context as UserPromptSubmit additional context', () => {
        const turnContext = 'Factory turn context\n- Current node: gate-fix';
        expect(JSON.parse(runHook({ FACTORY_TURN_CONTEXT: turnContext }))).toEqual({
            hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: turnContext },
        });
    });

    it('says nothing when the claim carried no turn context', () => {
        expect(runHook({})).toBe('');
        expect(runHook({ FACTORY_TURN_CONTEXT: '' })).toBe('');
    });

    // The kubernetes pod's env is frozen before the restore runs, so the restore step leaves its provenance in the
    // tree; the hook reads it at each prompt, after the restoration.
    it('adds the note a remote rebuild left in the tree, beside the claim turn context', () => {
        const tree = mkdtempSync(join(tmpdir(), 'hook-tree-'));
        mkdirSync(join(tree, '.factory'));
        writeFileSync(join(tree, '.factory', 'rebuilt-from-remote'), 'rebuilt from the pushed branch b\n');
        const out = JSON.parse(runHook({ FACTORY_TURN_CONTEXT: 'ctx' }, tree)) as {
            hookSpecificOutput: { additionalContext: string };
        };
        expect(out.hookSpecificOutput.additionalContext).toBe('ctx\n\nrebuilt from the pushed branch b');
        // Delivered once: the second prompt carries only the claim's own context.
        expect(runHook({}, tree)).toBe('');
        expect(JSON.parse(runHook({ FACTORY_TURN_CONTEXT: 'ctx' }, tree)).hookSpecificOutput.additionalContext).toBe(
            'ctx'
        );
    });

    it('is registered as the only UserPromptSubmit hook in the baked settings.json', () => {
        const settings = JSON.parse(read('docker/claude-executor/claude-home/settings.json')) as {
            hooks: Record<string, { hooks: { command: string }[] }[]>;
        };
        expect(settings.hooks.UserPromptSubmit!.flatMap((entry) => entry.hooks.map((hook) => hook.command))).toEqual([
            'node /usr/local/bin/turn-context-hook.cjs',
        ]);
    });

    it('is copied to /usr/local/bin, outside the redirected config dir', () => {
        expect(read('docker/claude-executor/Dockerfile')).toMatch(
            /COPY turn-context-hook\.cjs \/usr\/local\/bin\/turn-context-hook\.cjs\n/
        );
    });
});
