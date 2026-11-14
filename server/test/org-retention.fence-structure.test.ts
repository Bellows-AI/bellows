import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The retention pass's one door to destruction (`server/src/db/org-retention.ts`, docs/retention.md): every statement
 * that deletes, inserts or updates a row outside the lease table `org_retention` runs on a `FencedTx`, which only
 * `fencedStep` mints — under the org's plan-change lock and lease, with the window re-derived in that transaction. No
 * destructive statement can use a window captured earlier in the pass.
 */
const FILE = new URL('../src/db/org-retention.ts', import.meta.url);
const text = readFileSync(FILE, 'utf8');
const source = ts.createSourceFile('org-retention.ts', text, ts.ScriptTarget.Latest, true);
const DESTRUCTIVE = /\b(delete\s+from|insert\s+into|update)\s+(\w+)/gi;

function templateText(node: ts.TaggedTemplateExpression): string {
    const t = node.template;
    return ts.isNoSubstitutionTemplateLiteral(t)
        ? t.text
        : [t.head.text, ...t.templateSpans.map((s) => s.literal.text)].join(' ');
}

const tagged: ts.TaggedTemplateExpression[] = [];
const casts: ts.AsExpression[] = [];
const visit = (node: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(node)) tagged.push(node);
    if (ts.isAsExpression(node) && node.type.getText(source) === 'FencedTx') casts.push(node);
    ts.forEachChild(node, visit);
};
visit(source);

const enclosingFunction = (node: ts.Node): string | undefined => {
    for (let up: ts.Node | undefined = node.parent; up; up = up.parent) {
        if (ts.isFunctionDeclaration(up)) return up.name?.text;
    }
    return undefined;
};

/** The first parameter of the callback handed to `fencedStep(pass, callback)`: typed `FencedTx` by inference. */
const isStepCallback = (param: ts.ParameterDeclaration): boolean => {
    const fn = param.parent;
    const call = fn.parent;
    return (
        ts.isArrowFunction(fn) &&
        fn.parameters[0] === param &&
        call !== undefined &&
        ts.isCallExpression(call) &&
        call.expression.getText(source) === 'fencedStep' &&
        call.arguments[1] === fn
    );
};

describe('the retention pass', () => {
    it('runs every destructive statement on a fenced transaction', () => {
        const unfenced = tagged.flatMap((node) => {
            const tables = [...templateText(node).matchAll(DESTRUCTIVE)].map((m) => m[2]!.toLowerCase());
            const destructive = tables.filter((table) => table !== 'org_retention' && table !== 'set');
            return destructive.length > 0 && node.tag.getText(source) !== 'ftx'
                ? [`${node.tag.getText(source)}: ${templateText(node).trim().slice(0, 60)}`]
                : [];
        });
        expect(tagged.length).toBeGreaterThan(10);
        expect(unfenced).toEqual([]);
    });

    it('binds `ftx` only as a FencedTx parameter, and mints one only in fencedStep', () => {
        const loose: string[] = [];
        const find = (node: ts.Node): void => {
            if ((ts.isParameter(node) || ts.isVariableDeclaration(node)) && node.name.getText(source) === 'ftx') {
                if (!ts.isParameter(node) || !(node.type?.getText(source) === 'FencedTx' || isStepCallback(node))) {
                    loose.push(node.getText(source));
                }
            }
            ts.forEachChild(node, find);
        };
        find(source);
        expect(loose).toEqual([]);
        expect(casts.map(enclosingFunction)).toEqual(['fencedStep']);
    });
});
