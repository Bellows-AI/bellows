import type { Sql, TransactionSql } from 'postgres';

/**
 * The org and workspace skill versions a job row's task runs with (BEL-273, docs/skills.md): every enabled, live skill
 * its principal sees, resolved once when the row is made and carried unchanged by every row that continues it.
 */
export interface PinnedSkill {
    name: string;
    source: 'org' | 'workspace';
    versionId: string;
    sha256: string;
}

interface PinRow {
    name: string;
    user_id: string | null;
    version_id: string;
    sha256: string;
}

/**
 * Every enabled, live org skill and `ownerId`'s enabled workspace skills, at their current version; an org skill wins
 * a name the workspace also holds (core `resolveSkillCatalog`), the shadowed one is not pinned. A null `ownerId` (a job
 * with no member principal) pins the org skills only. Sorted by name so equal inputs pin equal arrays.
 */
export async function resolveSkillPinInTx(
    tx: Sql | TransactionSql,
    orgId: string,
    ownerId: string | null
): Promise<PinnedSkill[]> {
    const rows = await tx<PinRow[]>`
        select s.name, s.user_id, v.id as version_id, v.sha256
        from skill s join skill_version v on v.id = s.current_version_id
        where s.org_id = ${orgId} and s.deleted_at is null and s.enabled
          and (s.user_id is null or s.user_id = ${ownerId}::uuid)
        order by s.name, (s.user_id is null) desc
    `;
    const pin: PinnedSkill[] = [];
    for (const row of rows) {
        if (pin.at(-1)?.name === row.name) continue;
        pin.push({
            name: row.name,
            source: row.user_id === null ? 'org' : 'workspace',
            versionId: row.version_id,
            sha256: row.sha256,
        });
    }
    return pin;
}
