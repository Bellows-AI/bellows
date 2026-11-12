import { selectedBy } from '@factory-ai/core';
import type { Sql, TransactionSql } from 'postgres';
import { skillCatalog } from '../../skills.js';
import { bindingsOf, requirementsOf } from '../connection-bindings.js';

/**
 * The org and workspace skill versions a job row's task runs with (docs/skills.md): every enabled, live skill
 * its principal sees, resolved once when the row is made and carried unchanged by every row that continues it.
 */
export interface PinnedSkill {
    name: string;
    source: 'org' | 'workspace';
    versionId: string;
    sha256: string;
}

/**
 * A skill the row's CLI must not list (docs/skills.md): switched off by an admin or its owner, or needing a
 * connection the task does not hold (`connection` names it).
 */
export interface HiddenSkill {
    name: string;
    source: 'builtin' | 'org' | 'workspace';
    reason: 'switched_off' | 'needs_connection';
    connection?: string;
}

/** A row's skills: what it pins and what it hides; a name is never in both. */
export interface SkillDecision {
    pin: PinnedSkill[];
    hidden: HiddenSkill[];
}

interface StoredRow {
    name: string;
    user_id: string | null;
    enabled: boolean;
    version_id: string;
    sha256: string;
    requires_connections: string[];
}

/** The first connection `requires` names that the task demonstrably lacks; env-held connections are the claim's to check. */
function missingConnection(
    requires: readonly string[],
    held: { providers: ReadonlySet<string>; githubApp: boolean }
): string | undefined {
    return requires.find((connection) => {
        if (connection === 'github') return !held.githubApp;
        return selectedBy(connection) !== null && !held.providers.has(connection);
    });
}

type Verdict = (
    name: string,
    source: HiddenSkill['source'],
    enabled: boolean,
    requires: readonly string[]
) => HiddenSkill | null;

/**
 * Decides, for one job row, which skills are pinned and which are hidden. Run inside the row's transaction
 * AFTER its bindings are written, so a task that just bound Jira holds it. A switched-off skill is hidden; so is one
 * whose required connection is neither bound (whatever the connection's status) nor an open requirement, unless the
 * task selected it: a selection goes through the preflight and the open-requirement flow instead. A failed read
 * throws, aborting the transaction: nothing is ever narrowed on an unconfirmed answer.
 *
 * `stored: null` is a reviewer row: it pins nothing and holds no bindings, so only the built-ins are decided.
 * Otherwise every live org skill and the owner's workspace skills are decided (a workspace skill wins a name the org
 * also holds, core `resolveSkillCatalog`; a null owner sees the org's alone); the pin is sorted by name.
 */
export async function decideSkillVisibilityInTx(
    tx: Sql | TransactionSql,
    input: {
        orgId: string;
        githubApp: boolean;
        selected: readonly string[];
        stored: { ownerId: string | null; rootJobId: string } | null;
    }
): Promise<SkillDecision> {
    const { orgId, githubApp, selected, stored } = input;
    const off = new Set(
        (await tx<{ name: string }[]>`select name from builtin_skill_off where org_id = ${orgId}`).map((r) => r.name)
    );
    const providers = new Set<string>();
    if (stored) {
        for (const binding of await bindingsOf(tx, orgId, stored.rootJobId)) providers.add(binding.provider);
        for (const open of await requirementsOf(tx, orgId, stored.rootJobId)) providers.add(open.provider);
    }
    const pick = new Set(selected);
    const verdict: Verdict = (name, source, enabled, requires) => {
        if (!enabled) return { name, source, reason: 'switched_off' };
        const connection = pick.has(name) ? undefined : missingConnection(requires, { providers, githubApp });
        return connection === undefined ? null : { name, source, reason: 'needs_connection', connection };
    };
    const hidden: HiddenSkill[] = [];
    for (const skill of [...skillCatalog()].sort((a, b) => a.name.localeCompare(b.name))) {
        const found = verdict(skill.name, 'builtin', !off.has(skill.name), skill.requires.connections);
        if (found) hidden.push(found);
    }
    if (!stored) return { pin: [], hidden };
    const decided = await decideStored(tx, { orgId, ownerId: stored.ownerId, verdict });
    return { pin: decided.pin, hidden: [...hidden, ...decided.hidden] };
}

/** The org's live skills and the owner's workspace skills, each pinned or hidden; one decision per name, enabled and workspace first. */
async function decideStored(
    tx: Sql | TransactionSql,
    input: { orgId: string; ownerId: string | null; verdict: Verdict }
): Promise<SkillDecision> {
    const rows = await tx<StoredRow[]>`
        select s.name, s.user_id, s.enabled, v.id as version_id, v.sha256, v.requires_connections
        from skill s join skill_version v on v.id = s.current_version_id
        where s.org_id = ${input.orgId} and s.deleted_at is null
          and (s.user_id is null or s.user_id = ${input.ownerId}::uuid)
        order by s.name, s.enabled desc, (s.user_id is null) asc
    `;
    const decision: SkillDecision = { pin: [], hidden: [] };
    const seen = new Set<string>();
    for (const row of rows) {
        if (seen.has(row.name)) continue;
        seen.add(row.name);
        const source = row.user_id === null ? 'org' : 'workspace';
        const found = input.verdict(row.name, source, row.enabled, row.requires_connections);
        if (found) decision.hidden.push(found);
        else decision.pin.push({ name: row.name, source, versionId: row.version_id, sha256: row.sha256 });
    }
    return decision;
}

/**
 * Decides a row's skills (`decideSkillVisibilityInTx`) and writes both columns on the row just inserted with the empty
 * placeholders. Inside the row's transaction, after the bindings, so the decision and the row commit together.
 */
export async function recordSkillDecisionInTx(
    tx: TransactionSql,
    row: { orgId: string; jobId: string },
    input: Parameters<typeof decideSkillVisibilityInTx>[1]
): Promise<void> {
    const decision = await decideSkillVisibilityInTx(tx, input);
    await tx`
        update job set skill_pin = ${tx.json(decision.pin as never)}, skill_hidden = ${tx.json(decision.hidden as never)}
        where org_id = ${row.orgId} and id = ${row.jobId}
    `;
}

/** A created root's decision: the creator's workspace, the task's own selection and its bindings. */
export const recordCreateDecisionInTx = (
    tx: TransactionSql,
    row: {
        orgId: string;
        jobId: string;
        createdBy: string | null;
        target: { skills?: readonly string[] | undefined };
        githubApp: boolean | undefined;
    }
) =>
    recordSkillDecisionInTx(tx, row, {
        orgId: row.orgId,
        githubApp: row.githubApp === true,
        selected: row.target.skills ?? [],
        stored: { ownerId: row.createdBy, rootJobId: row.jobId },
    });

/**
 * A follow-up decides again, as the catalog, the switch and the thread's bindings are now: for the workspace of the
 * thread's owner (an admin's turn is still the owner's run) and the root's selection.
 */
export async function recordFollowUpDecisionInTx(
    tx: TransactionSql,
    input: { orgId: string; githubApp?: boolean | undefined },
    jobId: string,
    rootJobId: string
): Promise<void> {
    const { orgId } = input;
    const [root] = await tx<{ owner: string | null; skills: string[] }[]>`
        select execution_user_id as owner, skills from job where org_id = ${orgId} and id = ${rootJobId}
    `;
    await recordSkillDecisionInTx(
        tx,
        { orgId, jobId },
        {
            orgId,
            githubApp: input.githubApp === true,
            selected: root?.skills ?? [],
            stored: { ownerId: root?.owner ?? null, rootJobId },
        }
    );
}
