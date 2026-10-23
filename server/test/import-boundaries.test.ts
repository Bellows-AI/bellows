import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The value-import edges that keep `vitest related` narrow (issue #888): type-only imports are
 * stripped before a test runs, so only a value import couples a file to what it imports. Each case
 * names an entry module and the directory its closure of VALUE imports must never reach; a change
 * to the unreachable side then cannot re-run the entry's importers.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

function valueImportsOf(file: string): string[] {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const found: string[] = [];
    for (const statement of source.statements) {
        if (ts.isImportDeclaration(statement)) {
            const clause = statement.importClause;
            const named = clause?.namedBindings;
            const stripped =
                clause?.isTypeOnly === true ||
                (clause !== undefined &&
                    clause.name === undefined &&
                    named !== undefined &&
                    ts.isNamedImports(named) &&
                    named.elements.length > 0 &&
                    named.elements.every((element) => element.isTypeOnly));
            if (!stripped) found.push((statement.moduleSpecifier as ts.StringLiteral).text);
        } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && !statement.isTypeOnly) {
            found.push((statement.moduleSpecifier as ts.StringLiteral).text);
        }
    }
    return found.filter((specifier) => specifier.startsWith('.'));
}

function closureOf(entry: string): string[] {
    const seen = new Set<string>();
    const queue = [resolve(SRC, entry)];
    while (queue.length > 0) {
        const file = queue.pop()!;
        if (seen.has(file)) continue;
        seen.add(file);
        for (const specifier of valueImportsOf(file)) {
            const target = resolve(dirname(file), specifier.replace(/\.js$/, '.ts'));
            if (existsSync(target)) queue.push(target);
        }
    }
    return [...seen].map((file) => relative(SRC, file)).sort();
}

describe('value-import boundaries', () => {
    it.each([
        ['config.ts', ['artifacts/', 'db/', 'routes/']],
        ['config-artifacts.ts', ['artifacts/', 'db/', 'routes/']],
        ['artifacts/keys.ts', ['config', 'db/']],
        ['db/workflows/workflow-blocks/index.ts', ['db/jobs/', 'db/batches/']],
        ['routes/jobs/job-idempotency.ts', ['db/jobs/job-store-rows.ts', 'db/batches/']],
        ['routes/batches/batch-handlers.ts', ['db/jobs/job-store-rows.ts', 'db/batches/batch-store.ts']],
    ])('%s never reaches %j through value imports', (entry, forbidden) => {
        const reached = closureOf(entry);
        const offending = reached.filter((file) => forbidden.some((prefix) => file.startsWith(prefix)));
        // The entry itself may live under a forbidden prefix (artifacts/keys.ts under artifacts/).
        expect(offending.filter((file) => file !== entry)).toEqual([]);
    });
});
