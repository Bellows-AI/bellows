import { ExecutorConnectionRefusedError } from '../src/db/executor-connection-selection.js';
import {
    type AgentDefault,
    ExecutorDefaultNotFoundError,
    ExecutorSuspendedError,
    type ExecutorDefault,
    type ExecutorProfile,
    type UserExecutorStore,
} from '../src/db/user-executor-store.js';
import {
    type ConnectionSelectionRefusal,
    DEFAULT_GATE_FIX_ROUNDS,
    USER_SCOPE,
    type ExecutorScope,
} from '@factory-ai/core';

export interface MemoryUserExecutorStore extends UserExecutorStore {
    /**
     * Every row, personal and org alike, so a test can assert what a PUT wrote, what it replaced,
     * and that an org row survived a personal save.
     */
    rows(): {
        id: string;
        userId: string | null;
        name: string;
        type: string;
        config: Record<string, unknown>;
        gateFixRounds: number;
        createdBy: string | null;
        suspended: boolean;
        runnerClass: string | null;
    }[];
    /** The stored per-member default preferences, so a test can assert what a route wrote. */
    defaults(): { userId: string; scope: ExecutorScope; name: string }[];
}

/**
 * An in-memory UserExecutorStore, for route tests that need no database. The SQL behind it
 * is covered by server/test-db, which needs a container. The scope semantics mirror the SQL: a
 * NULL owner is the org scope, personal rows key on their owner, and a name may exist once per
 * ownership — the coalesce index's shape, simulated with a keyed lookup.
 */
export function memoryUserExecutorStore(
    /** The selection rule the SQL store runs in its transaction; a refusal it returns is thrown. Absent: every id passes. */
    refuseSelection: (selection: {
        owner: string | null;
        connectionId: string;
        type: string;
        model: unknown;
    }) => ConnectionSelectionRefusal | null = () => null
): MemoryUserExecutorStore {
    const judge = (owner: string | null, connectionId: string | null, type: string, config: unknown) => {
        if (connectionId === null) return;
        const model = typeof config === 'object' && config !== null ? (config as { model?: unknown }).model : undefined;
        const refusal = refuseSelection({ owner, connectionId, type, model });
        if (refusal) throw new ExecutorConnectionRefusedError(refusal.reason, refusal.message);
    };
    interface Row {
        id: string;
        userId: string | null;
        name: string;
        type: string;
        config: Record<string, unknown>;
        gateFixRounds: number;
        createdBy: string | null;
        suspended: boolean;
        runnerClass: string | null;
        providerConnectionId: string | null;
        position: number;
        createdAt: string;
        updatedAt: string;
    }
    const rows: Row[] = [];
    const preferences = new Map<string, ExecutorDefault>();
    /** Agent defaults keyed by owner: a member's id, or `''` for the organization's row. */
    const agentDefaults = new Map<string, AgentDefault>();
    const ownerKey = (owner: string | null) => owner ?? '';
    /** The SQL's upsert: a write without a provider keeps the one the row recorded. */
    const writeAgentDefault = (owner: string | null, value: AgentDefault) => {
        const provider = value.provider ?? agentDefaults.get(ownerKey(owner))?.provider;
        const row = { agentType: value.agentType, model: value.model };
        agentDefaults.set(ownerKey(owner), provider === undefined ? row : { ...row, provider });
    };
    let nextId = 1;
    const at = () => new Date().toISOString();
    const uuid = () => {
        const id = `${String(nextId).padStart(8, '0')}-0000-4000-8000-${String(nextId).padStart(12, '0')}`;
        nextId += 1;
        return id;
    };

    /** The one conflict a name-uniqueness index can raise, shaped like postgres' own error. */
    const nameTaken = (name: string, scope: string): Error =>
        Object.assign(new Error(`an executor named "${name}" already exists in the ${scope} scope`), {
            code: '23505',
        });

    const assertFree = (userId: string | null, name: string) => {
        if (rows.some((r) => r.userId === userId && r.name === name))
            throw nameTaken(name, userId ? 'personal' : 'org');
    };

    const byScope = (userId: string | null) =>
        rows.filter((r) => r.userId === userId).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));

    const toProfile = (r: Row): ExecutorProfile => ({
        id: r.id,
        name: r.name,
        type: r.type,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        gateFixRounds: r.gateFixRounds,
        createdBy: r.createdBy,
        suspended: r.suspended,
        runnerClass: r.runnerClass,
        providerConnectionId: r.providerConnectionId,
    });

    return {
        rows: () =>
            rows.map((r) => ({
                id: r.id,
                userId: r.userId,
                name: r.name,
                type: r.type,
                config: structuredClone(r.config),
                gateFixRounds: r.gateFixRounds,
                createdBy: r.createdBy,
                suspended: r.suspended,
                runnerClass: r.runnerClass,
            })),

        defaults: () => [...preferences.entries()].map(([key, def]) => ({ userId: key, ...def })),

        async replace(userId, executors) {
            const suspendedNames = new Set(rows.filter((r) => r.userId === userId && r.suspended).map((r) => r.name));
            const previous = new Map(
                rows.filter((r) => r.userId === userId).map((r) => [r.name, r.providerConnectionId])
            );
            const connectionOf = (executor: (typeof executors)[number]) =>
                executor.providerConnectionId === undefined
                    ? (previous.get(executor.name) ?? null)
                    : executor.providerConnectionId;
            for (const executor of executors) judge(userId, connectionOf(executor), executor.type, executor.config);
            for (let i = rows.length - 1; i >= 0; i -= 1) {
                if (rows[i]!.userId === userId) rows.splice(i, 1);
            }
            for (const executor of executors) {
                rows.push({
                    id: uuid(),
                    userId,
                    name: executor.name,
                    type: executor.type,
                    config: structuredClone(executor.config),
                    gateFixRounds: executor.gateFixRounds ?? DEFAULT_GATE_FIX_ROUNDS,
                    createdBy: null,
                    suspended: executor.suspended ?? suspendedNames.has(executor.name),
                    runnerClass: null,
                    providerConnectionId: connectionOf(executor),
                    position: rows.filter((r) => r.userId === userId).length,
                    createdAt: at(),
                    updatedAt: at(),
                });
            }
        },

        async removePersonal(userId, id) {
            const index = rows.findIndex((r) => r.id === id && r.userId === userId);
            if (index === -1) return false;
            rows.splice(index, 1);
            return true;
        },

        async setPersonalSuspended(userId, id, suspended) {
            const row = rows.find((r) => r.id === id && r.userId === userId);
            if (!row) return null;
            row.suspended = suspended;
            row.updatedAt = at();
            return toProfile(row);
        },

        async setOrgSuspended(id, suspended) {
            const row = rows.find((r) => r.id === id && r.userId === null);
            if (!row) return null;
            row.suspended = suspended;
            row.updatedAt = at();
            return toProfile(row);
        },

        async list(userId) {
            return byScope(userId).map(toProfile);
        },

        async listWithConfigs(userId) {
            return byScope(userId).map((r) => ({ ...toProfile(r), config: structuredClone(r.config) }));
        },

        async configFor(userId, name, scope = USER_SCOPE) {
            const owner = scope === USER_SCOPE ? userId : null;
            const row = rows.find((r) => r.userId === owner && r.name === name);
            if (!row) return null;
            return {
                type: row.type,
                config: structuredClone(row.config),
                gateFixRounds: row.gateFixRounds,
                suspended: row.suspended,
                runnerClass: row.runnerClass,
                ...(row.providerConnectionId === null ? {} : { providerConnectionId: row.providerConnectionId }),
            };
        },

        async ready() {},

        // The fake stores configs as sent, so there is no stored credential to resolve.
        async claimConfigFor(userId, name, scope) {
            return this.configFor(userId, name, scope);
        },

        async listOrg() {
            return byScope(null).map(toProfile);
        },

        async listOrgWithConfigs() {
            return byScope(null).map((r) => ({ ...toProfile(r), config: structuredClone(r.config) }));
        },

        async createOrg(input) {
            assertFree(null, input.name);
            judge(null, input.providerConnectionId ?? null, input.type, input.config);
            const row: Row = {
                id: uuid(),
                userId: null,
                name: input.name,
                type: input.type,
                config: structuredClone(input.config),
                gateFixRounds: input.gateFixRounds ?? DEFAULT_GATE_FIX_ROUNDS,
                createdBy: input.createdBy,
                suspended: false,
                runnerClass: input.runnerClass ?? null,
                providerConnectionId: input.providerConnectionId ?? null,
                position: byScope(null).length,
                createdAt: at(),
                updatedAt: at(),
            };
            rows.push(row);
            return { ...toProfile(row), config: structuredClone(row.config) };
        },

        async updateOrg(id, patch) {
            const row = rows.find((r) => r.id === id && r.userId === null);
            if (!row) return null;
            judge(
                null,
                patch.providerConnectionId === undefined ? row.providerConnectionId : patch.providerConnectionId,
                patch.type ?? row.type,
                patch.config ?? row.config
            );
            if (patch.name !== undefined && patch.name !== row.name) {
                assertFree(null, patch.name);
                row.name = patch.name;
            }
            if (patch.type !== undefined) row.type = patch.type;
            if (patch.config !== undefined) row.config = structuredClone(patch.config);
            if (patch.gateFixRounds !== undefined) row.gateFixRounds = patch.gateFixRounds;
            if (patch.runnerClass !== undefined) row.runnerClass = patch.runnerClass;
            if (patch.providerConnectionId !== undefined) row.providerConnectionId = patch.providerConnectionId;
            row.updatedAt = at();
            return { ...toProfile(row), config: structuredClone(row.config) };
        },

        async deleteOrg(id) {
            const index = rows.findIndex((r) => r.id === id && r.userId === null);
            if (index === -1) return false;
            rows.splice(index, 1);
            return true;
        },

        async changeScope(id, to, userId) {
            const row = rows.find((r) => r.id === id);
            if (!row) return null;
            if (to === USER_SCOPE) {
                if (row.userId !== null) return null;
                judge(userId, row.providerConnectionId, row.type, undefined);
                assertFree(userId, row.name);
                row.userId = userId;
                row.createdBy = null;
                // A personal profile names no runner class, as the row check holds in SQL.
                row.runnerClass = null;
                row.position = byScope(userId).length - 1;
            } else {
                // Only the caller's OWN personal row promotes.
                if (row.userId !== userId) return null;
                judge(null, row.providerConnectionId, row.type, undefined);
                assertFree(null, row.name);
                row.userId = null;
                row.createdBy = userId;
                row.position = byScope(null).length - 1;
            }
            row.updatedAt = at();
            return toProfile(row);
        },

        async orgCount() {
            return rows.filter((r) => r.userId === null).length;
        },

        async defaultOf(userId) {
            return preferences.get(userId) ?? null;
        },

        async setDefault(userId, def) {
            const owner = def.scope === USER_SCOPE ? userId : null;
            const named = rows.find((r) => r.userId === owner && r.name === def.name);
            if (!named) throw new ExecutorDefaultNotFoundError(`No ${def.scope} executor named "${def.name}"`);
            if (named.suspended)
                throw new ExecutorSuspendedError(`The ${def.scope} executor "${def.name}" is suspended`);
            preferences.set(userId, { ...def });
        },

        async resolvedDefault(userId) {
            const stored = preferences.get(userId);
            if (stored) {
                const owner = stored.scope === USER_SCOPE ? userId : null;
                if (rows.some((r) => r.userId === owner && r.name === stored.name && !r.suspended))
                    return { kind: 'profile', ...stored };
            }
            const { personal: personalAgent, org: orgAgent } = await this.agentDefaults(userId);
            if (personalAgent) return { kind: 'agent', ...personalAgent, from: 'personal' };
            if (orgAgent) return { kind: 'agent', ...orgAgent, from: 'org' };
            const personal = byScope(userId).find((r) => !r.suspended);
            if (personal) return { kind: 'profile', scope: USER_SCOPE, name: personal.name };
            const orgRow = byScope(null).find((r) => !r.suspended);
            if (orgRow) return { kind: 'profile', scope: 'org', name: orgRow.name };
            return null;
        },

        async agentDefaults(userId) {
            return { org: agentDefaults.get(ownerKey(null)) ?? null, personal: agentDefaults.get(userId) ?? null };
        },

        async setAgentDefault(owner, value) {
            writeAgentDefault(owner, value);
        },

        async setAgentDefaultInTx(_tx, owner, value) {
            writeAgentDefault(owner, value);
        },

        async agentDefaultInTx(_tx, owner) {
            return agentDefaults.get(ownerKey(owner)) ?? null;
        },

        async deleteAgentDefault(owner) {
            return agentDefaults.delete(ownerKey(owner));
        },
    };
}
