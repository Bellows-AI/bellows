import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ORG_TABLES } from '../src/db/org-tables.js';

/**
 * From 154 the org policies bind the owner the migrations run as, so a data migration that writes org rows as the
 * owner reads and changes nothing on a managed database whose owner has no BYPASSRLS, and says nothing: the image's
 * superuser, which CI runs as, ignores the policies. Every migration after 154 that inserts, updates or deletes an
 * org table's rows therefore takes the cross-org role first. Function bodies run when called, not at migration
 * time, and are not scanned.
 */
const FORCED_AT = 154;
const ORG = new Set<string>(ORG_TABLES);
const DML = /\b(?:insert\s+into|update|delete\s+from)\s+(?:only\s+)?"?(\w+)"?/gi;
const CROSS_ORG = /\bset\s+(?:local\s+)?role\s+"?bellows_cross_org"?/i;

/** The org tables `sql` writes as the owner: before any `set role bellows_cross_org`. */
function ownerWrites(sql: string): string[] {
    const body = sql
        .replace(/--[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/create\s+(?:or\s+replace\s+)?(?:function|procedure)\b[\s\S]*?(\$\w*\$)[\s\S]*?\1/gi, '');
    const role = body.search(CROSS_ORG);
    const writes: string[] = [];
    for (const match of body.matchAll(DML)) {
        const table = match[1]!.toLowerCase();
        if (ORG.has(table) && (role < 0 || match.index < role)) writes.push(table);
    }
    return writes;
}

describe('a migration after the forced policies', () => {
    it('flags an org-row write as the owner, and passes one after the cross-org role or inside a function body', () => {
        expect(ownerWrites("update job set status = 'done' where id = 'x';\ndelete from session;")).toEqual([
            'job',
            'session',
        ]);
        expect(ownerWrites('do $$ begin insert into "org_plan" (org_id) values (\'o\'); end $$;')).toEqual([
            'org_plan',
        ]);
        expect(ownerWrites("set local role bellows_cross_org;\nupdate job set status = 'done';")).toEqual([]);
        expect(
            ownerWrites(
                'create or replace function f() returns trigger language plpgsql as $fn$ begin delete from job; ' +
                    'return null; end $fn$;\ncreate trigger t after update on job for each row execute function f();'
            )
        ).toEqual([]);
        expect(ownerWrites('-- update job set x = 1\nalter table job add column y text;')).toEqual([]);
    });

    it('takes the cross-org role before writing any org row', () => {
        const dir = new URL('../migrations/', import.meta.url);
        const offending = readdirSync(dir)
            .filter((name) => /^\d+_.*\.sql$/.test(name) && !name.includes('.repeatable.'))
            .filter((name) => Number.parseInt(name, 10) > FORCED_AT)
            .flatMap((name) => ownerWrites(readFileSync(new URL(name, dir), 'utf8')).map((t) => `${name}: ${t}`));
        expect(offending).toEqual([]);
    });
});
