import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

/**
 * Outside the pass, any file that reads a retention window and deletes rows does so only in a transaction that took
 * the window first through `lockedRetentionWindow` (the plan-change lock, the window re-derived from the current plan).
 */
const SERVER_SRC = new URL('../src/', import.meta.url);
const WINDOW_READ = /effective_days|retentionDays|org_retention|lockedRetentionWindow/;

function sourcesUnder(dir: URL): string[] {
    return readdirSync(dir, { recursive: true, encoding: 'utf8' })
        .filter((name) => name.endsWith('.ts'))
        .map((name) => fileURLToPath(new URL(name, dir)));
}

/** The `delete from` statements of `file` not inside a transaction callback that called lockedRetentionWindow first. */
function unlockedDeletes(file: string): { deletes: number; unlocked: string[] } {
    const body = readFileSync(file, 'utf8');
    const tree = ts.createSourceFile(file, body, ts.ScriptTarget.Latest, true);
    let deletes = 0;
    const unlocked: string[] = [];
    const walk = (node: ts.Node): void => {
        if (ts.isTaggedTemplateExpression(node)) {
            const t = node.template;
            const text = ts.isNoSubstitutionTemplateLiteral(t)
                ? t.text
                : [t.head.text, ...t.templateSpans.map((s) => s.literal.text)].join(' ');
            if (/\bdelete\s+from\b/i.test(text)) {
                deletes++;
                if (!lockedBefore(node, tree)) unlocked.push(text.trim().slice(0, 60));
            }
        }
        ts.forEachChild(node, walk);
    };
    walk(tree);
    return { deletes, unlocked };
}

/** The nearest enclosing `.begin(callback)` callback calls lockedRetentionWindow before `node`. */
function lockedBefore(node: ts.Node, tree: ts.SourceFile): boolean {
    for (let up: ts.Node | undefined = node.parent; up; up = up.parent) {
        const call = up.parent;
        if (
            (ts.isArrowFunction(up) || ts.isFunctionExpression(up)) &&
            call &&
            ts.isCallExpression(call) &&
            ts.isPropertyAccessExpression(call.expression) &&
            call.expression.name.text === 'begin'
        ) {
            const before = tree.text.slice(up.getStart(tree), node.getStart(tree));
            return before.includes('lockedRetentionWindow(');
        }
    }
    return false;
}

describe('every retention-window delete outside the pass', () => {
    it('runs under the plan-change lock with the window re-derived in its transaction', () => {
        const readers = sourcesUnder(SERVER_SRC).filter(
            (file) => !file.endsWith('db/org-retention.ts') && WINDOW_READ.test(readFileSync(file, 'utf8'))
        );
        const findings = readers.map((file) => ({ file, ...unlockedDeletes(file) }));
        const collector = findings.find((f) => f.file.endsWith('skills/skill-collector.ts'));
        expect(collector?.deletes).toBeGreaterThanOrEqual(2);
        expect(findings.filter((f) => f.unlocked.length > 0).map((f) => [f.file, f.unlocked])).toEqual([]);
    });
});
