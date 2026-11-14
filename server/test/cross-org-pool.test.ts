import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The `bypassrls` pool reaches only the paths docs/row-level-security.md lists: `main.ts` builds it once, as
 * `crossOrg`, and every call that receives `crossOrg` is named below. A new consumer fails here until it is listed in
 * both places; anything else runs on the request pool, where the policies bind it.
 */
const SRC = new URL('../src/', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, SRC), 'utf8');

/** Each call `crossOrg` is passed to in main.ts, and why it reads across organizations. */
const CROSS_ORG_CALLS = {
    // The owner-free part of boot: sessions and pending sign-ins, then every credential lookup.
    createAuthStore: 'sign-in, sessions, personal and org tokens resolve to an org',
    membershipGuardFor: "GitHub's membership answer re-checks every org's members",
    mcpStores: 'OAuth clients, codes, grants and upload capabilities resolve to an org, and their expiry sweeps',
    bootstrappedDriverCredentials: 'a driver credential resolves to the orgs it serves; the bootstrap writes one',
    createOrgOfLease: 'a lease pair resolves to its org',
    createOrgOfIngest: 'an ingest token resolves to its org',
    createOrgOfJob: 'a job id on a worker route resolves to its org',
    createOrgOfReclaim: 'a reclaim resolves to its org',
    runnerCredentialDeps: 'carries the two lease lookups below',
    createAttemptOfLease: 'a lease token resolves to its attempt and org',
    createPairMatches: 'a lease pair is checked before its org is known',
    createIntegrationRuntime: 'the recovery of every org’s authorizations left mid-exchange',
    startCollectors: 'carries the sweeps below',
    startAttachmentSweep: 'deletes objects no row of any org references',
    startSkillSweep: 'deletes skill objects no row of any org references',
    startOrgPurge: "deletes a deleted org's rows and objects",
    startMetricPointOrgBackfill: 'resolves the org of points stored before they carried one',
} as const;

/** The callee of each call `crossOrg` reaches as an argument, or inside one (spread, property, object). */
function calleesOf(file: string, text: string, name = 'crossOrg'): string[] {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const callees: string[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && node.text === name) {
            for (let up: ts.Node | undefined = node.parent; up; up = up.parent) {
                if (ts.isFunctionLike(up) || ts.isVariableDeclaration(up)) break;
                if (ts.isCallExpression(up) && up.arguments.some((arg) => arg.pos <= node.pos && node.end <= arg.end)) {
                    const callee = up.expression;
                    callees.push(ts.isIdentifier(callee) ? callee.text : callee.getText(source));
                    break;
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return callees;
}

function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return sourceFiles(path);
        return path.endsWith('.ts') ? [path] : [];
    });
}

describe('the cross-org pool', () => {
    it('is built once, in main.ts, and handed only to the listed calls', () => {
        const main = read('main.ts');
        expect(main.match(/crossOrgPool\(/g)).toHaveLength(1);
        expect(main.match(/\bcrossOrgSql\b/g)?.length).toBeGreaterThanOrEqual(2);
        const callees = calleesOf('main.ts', main);
        expect([...new Set(callees)].sort()).toEqual(Object.keys(CROSS_ORG_CALLS).sort());
    });

    it('leaves the owner to the migrations: main.ts hands the owner pool to nothing else', () => {
        // The policies exempt the owner until a later release forces them, so a request on it would bypass them.
        const callees = calleesOf('main.ts', read('main.ts'), 'ownerSql');
        expect([...new Set(callees)].sort()).toEqual(['createClose', 'migrateAsOwner']);
    });

    it('is reached through crossOrgPool alone: no other module names the bypassing role', () => {
        const root = new URL('../src/', import.meta.url).pathname;
        const naming = sourceFiles(root)
            .filter((path) => /CROSS_ORG_ROLE|crossOrgPool\(|bellows_cross_org/.test(readFileSync(path, 'utf8')))
            .map((path) => path.slice(root.length))
            .sort();
        expect(naming).toEqual([
            'auth/driver-credential-cli.ts',
            'db/migrate.ts',
            'db/org-sql.ts',
            'db/pool.ts',
            'main.ts',
        ]);
    });

    it('is listed, call for call, in docs/row-level-security.md', () => {
        const doc = readFileSync(new URL('../../docs/row-level-security.md', import.meta.url), 'utf8');
        expect(Object.keys(CROSS_ORG_CALLS).filter((name) => !doc.includes(`\`${name}\``))).toEqual([]);
    });
});
