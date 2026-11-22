import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * BEL-531: commits are AUTHORED by the member (GIT_AUTHOR_* env, set by the driver) and COMMITTED by the bot. The
 * shipped scripts that configure a local identity configure the committer only: a `user.*` config never shadows the
 * author env, and no script may set an author or committer env that would.
 */
const BOT_EMAIL = 'factory-ai@users.noreply.github.com';
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe.each(['../src/scripts/task-checkout.cjs', '../src/scripts/merge-conflict-probe.cjs'])('%s', (path) => {
    const bytes = read(path);

    it('falls back to the bot as the committer identity, only when git has none', () => {
        expect(bytes).toContain(`'user.email', '${BOT_EMAIL}'`);
        expect(bytes).toMatch(/git var GIT_COMMITTER_IDENT|'var', 'GIT_COMMITTER_IDENT'/);
    });

    it('never overrides the author the claim set', () => {
        expect(bytes).not.toMatch(/GIT_AUTHOR_(NAME|EMAIL)/);
    });
});

describe.each(['../../docker/claude-executor/Dockerfile', '../../docker/opencode-executor/Dockerfile'])(
    '%s',
    (path) => {
        it('names the bot as the default identity, which the author env overrides for authorship alone', () => {
            const bytes = read(path);
            expect(bytes).toContain(`email = ${BOT_EMAIL}`);
            expect(bytes).not.toMatch(/^\s*ENV .*GIT_(AUTHOR|COMMITTER)/m);
        });
    }
);
