import type { Sql, TransactionSql } from 'postgres';
import type { ExecutorType } from '@factory-ai/core';

/**
 * The agent and model a task runs on when no executor profile is named and the member's preference does not resolve
 * (157_agent_default.sql). One row per organization (`user_id` null) and one per member.
 */
export interface AgentDefault {
    readonly agentType: ExecutorType;
    readonly model: string;
}

/** What `GET /api/agent-default` answers: the organization's row and the caller's own, each null when unset. */
export interface AgentDefaults {
    readonly org: AgentDefault | null;
    readonly personal: AgentDefault | null;
}

interface Row {
    user_id: string | null;
    agent_type: ExecutorType;
    model: string;
}

const toAgentDefault = (row: Row | undefined): AgentDefault | null =>
    row ? { agentType: row.agent_type, model: row.model } : null;

/** Both rows the member resolves through, in one read. A failed read throws: it is never "no default". */
export async function readAgentDefaults(sql: Sql, orgId: string, userId: string): Promise<AgentDefaults> {
    const rows = await sql<Row[]>`
        select user_id, agent_type, model from agent_default
        where org_id = ${orgId} and (user_id is null or user_id = ${userId})
    `;
    return {
        org: toAgentDefault(rows.find((row) => row.user_id === null)),
        personal: toAgentDefault(rows.find((row) => row.user_id !== null)),
    };
}

/**
 * Writes the row `owner` names (null: the organization's) inside the caller's transaction, replacing what it held.
 * The two partial unique indexes are the conflict targets.
 */
export async function writeAgentDefault(
    tx: TransactionSql,
    orgId: string,
    owner: string | null,
    value: AgentDefault
): Promise<void> {
    if (owner === null) {
        await tx`
            insert into agent_default (org_id, user_id, agent_type, model)
            values (${orgId}, null, ${value.agentType}, ${value.model})
            on conflict (org_id) where user_id is null do update
            set agent_type = excluded.agent_type, model = excluded.model, updated_at = now()
        `;
        return;
    }
    await tx`
        insert into agent_default (org_id, user_id, agent_type, model)
        values (${orgId}, ${owner}, ${value.agentType}, ${value.model})
        on conflict (org_id, user_id) where user_id is not null do update
        set agent_type = excluded.agent_type, model = excluded.model, updated_at = now()
    `;
}

/** Removes the row `owner` names (null: the organization's). False when there was none. */
export async function removeAgentDefault(sql: Sql, orgId: string, owner: string | null): Promise<boolean> {
    const rows = await sql`
        delete from agent_default
        where org_id = ${orgId} and user_id is not distinct from ${owner}
        returning 1
    `;
    return rows.length > 0;
}

/**
 * The store's agent default methods (`UserExecutorStore`), bound to one organization. `gate` is the store's boot gate
 * (`convertedGate`); a write inside the caller's transaction does not wait on it, the database being up already.
 */
export function agentDefaultMethods(sql: Sql, orgId: string, gate: () => Promise<void>) {
    return {
        async agentDefaults(userId: string): Promise<AgentDefaults> {
            await gate();
            return readAgentDefaults(sql, orgId, userId);
        },
        async setAgentDefault(owner: string | null, value: AgentDefault): Promise<void> {
            await gate();
            await sql.begin((tx) => writeAgentDefault(tx, orgId, owner, value));
        },
        async setAgentDefaultInTx(tx: TransactionSql, owner: string | null, value: AgentDefault): Promise<void> {
            await writeAgentDefault(tx, orgId, owner, value);
        },
        async deleteAgentDefault(owner: string | null): Promise<boolean> {
            await gate();
            return removeAgentDefault(sql, orgId, owner);
        },
    };
}
