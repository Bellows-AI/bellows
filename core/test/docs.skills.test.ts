import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The workspace-over-repo skill rule in docs/skills.md: a pinned workspace skill the checkout also holds is listed once,
 * and the one residual race is a stated limit. Whitespace-sensitive: each pin is one sentence of the doc.
 */

const doc = readFileSync(new URL('../../docs/skills.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');

describe('the pinned workspace skill rule', () => {
    it('states the one-copy invariant and the narrowed opencode limit', () => {
        expect(doc).toContain(
            'A pinned workspace skill the checkout also holds is listed once, the workspace copy, on both CLIs'
        );
        expect(doc).toContain(
            "Stated limit: on opencode, a same-name skill under the checkout's `.opencode/skill` or `.opencode/skills` still races the workspace copy, with no warning."
        );
    });

    it('no longer states the retired claude and opencode limits', () => {
        expect(doc).not.toContain('it ranks below the repo');
        expect(doc).not.toContain('is a race that load decides');
    });
});
