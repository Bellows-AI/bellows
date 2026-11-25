import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * A claim marked in flight (`lineage_sent_at`) ends only by a commit or by sending the grant to reconnect
 * (docs/connections.md). The database statement enforces it (`endClaim` refuses any other end of a marked claim:
 * `server/test-db/gitlab-member-grant.test.ts`); this pins, in the source, that no caller in the refresh flow asks for
 * an ordinary release, and that the one explicit exception (`provablyUnsent`) is named in exactly two places.
 */
const SRC = new URL('../src/integrations/', import.meta.url);

/** Every `endClaim(...)` call of a file, with the text of its options argument ('' when it passes none). */
function endClaimCalls(file: string): { line: number; options: string }[] {
    const text = readFileSync(new URL(file, SRC), 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const calls: { line: number; options: string }[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'endClaim') {
            const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
            calls.push({ line, options: node.arguments[2]?.getText(source) ?? '' });
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return calls;
}

describe('the exits of an in-flight claim', () => {
    it.each(['grant-lineage.ts', 'lineage-commit.ts'])(
        '%s never asks for an ordinary release: every end sends the grant to reconnect or says the request provably never left',
        (file) => {
            const calls = endClaimCalls(file);
            expect(calls.length).toBeGreaterThan(0);
            for (const { line, options } of calls) {
                // The facade's pass-through (`releaseClaim`, for reconsent claims) is guarded by the statement itself.
                if (options === 'options ?? {}') continue;
                expect(options, `${file}:${line}`).toMatch(/reconnect|provablyUnsent/);
            }
        }
    );

    it('names provablyUnsent in the statement and at the two places that know the request never spent the token', () => {
        const named = (file: string) =>
            (readFileSync(new URL(file, SRC), 'utf8').match(/provablyUnsent: true/g) ?? []).length;
        expect(named('grant-lineage.ts')).toBe(2);
        // The definition and its use in the statement; nowhere else in the lineage modules.
        for (const file of [
            'lineage-commit.ts',
            'lineage-recovery.ts',
            'lineage-destroy.ts',
            'authorization-complete.ts',
        ]) {
            expect(named(file), file).toBe(0);
        }
        expect(readFileSync(new URL('lineage-claims.ts', SRC), 'utf8')).toContain('options.provablyUnsent === true');
    });

    it('marks the claim before the refresh request is built', () => {
        const text = readFileSync(new URL('grant-lineage.ts', SRC), 'utf8');
        expect(text.indexOf('markInFlight(ctx, claim)')).toBeGreaterThan(0);
        expect(text.indexOf('markInFlight(ctx, claim)')).toBeLessThan(text.indexOf('hooks\n            .refresh('));
    });
});
