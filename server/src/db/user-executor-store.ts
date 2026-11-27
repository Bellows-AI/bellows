import type { Sql, TransactionSql } from 'postgres';
import { DEFAULT_GATE_FIX_ROUNDS, ORG_SCOPE, USER_SCOPE, type ExecutorScope } from '@factory-ai/core';
import type { SecretDiagnostic, SecretStore } from '../secrets/secret-store.js';
import { type AgentDefault, type AgentDefaults, agentDefaultMethods } from './agent-default-sql.js';
import {
    assertConnectionSelection,
    assertMovedSelection,
    lockOrgRowForUpdate,
    modelOf,
    selectedOf,
} from './executor-connection-selection.js';
import { type PersonalExecutorEntry, replacePersonalRows } from './executor-personal-replace.js';
import {
    assertUnselected,
    type DefaultSelection,
    ExecutorDefaultProtectedError,
    isSelectionReferenceViolation,
    protectedMessage,
    resolveOrphanedSelections,
    type DefaultResolution,
    resolveConfiguredDefault,
    selectionMethods,
} from './executor-default-store.js';
import {
    convertedGate,
    type ExecutorCredentialDeps,
    resolveCredentials,
    retireCredentials,
    type StoredCredential,
    storedOf,
    writeSealed,
} from './executor-credentials.js';

export type { AgentDefault, AgentDefaults } from './agent-default-sql.js';
export {
    ConfiguredDefaultUnusableError,
    ExecutorDefaultNotFoundError,
    ExecutorDefaultProtectedError,
    ExecutorIdentityError,
    ExecutorSuspendedError,
} from './executor-default-store.js';
export type { DefaultResolution, DefaultSelection } from './executor-default-store.js';

/**
 * One executor profile: a member's personal row (`userId` set) or an organization-wide row the
 * administrators manage and every member may select (issue 391). The table is one, with sibling
 * scopes — 027_workflows.sql's shape — so the nullness of the owner is the scope, and a scope
 * column would say the same thing twice.
 */
export interface ExecutorProfile {
    /** The surrogate key (047): org CRUD and scope changes address rows by it. */
    readonly id: string;
    readonly name: string;
    readonly type: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    /**
     * The default workflow's gate-repair round limit this row launches with: bounded
     * 0-10, 3 when unset, 0 disables automatic repair. Read once at launch, frozen onto the
     * thread's root row — editing it later changes later tasks, never a running thread.
     */
    readonly gateFixRounds: number;
    /**
     * The administrator who created (or last promoted) an org-scope row — an audit fact, not an
     * ownership. Null on personal rows, whose `userId`-keyed whole-list PUT has no creator apart
     * from the owner.
     */
    readonly createdBy: string | null;
    /**
     * Taken out of service (issue 440): still listed, configured and owned, but not selectable, not
     * a valid default, and refused at submission and claim. Resuming clears it.
     */
    readonly suspended: boolean;
    /**
     * The runner class the profile's tasks run in (RUNNER_CLASSES); null is the driver's default. Set on
     * org rows only, by an admin — `executor_profile_runner_class_ck` keeps a personal row at null.
     * Resolved at claim like the type, so an edit reaches every later claim.
     */
    readonly runnerClass: string | null;
    /**
     * The provider connection the profile runs its model on (docs/workspace.md), or null for the stacked env and
     * the pasted config alone. An id, never a credential: the claim resolves the key from the secret store.
     */
    readonly providerConnectionId: string | null;
    /**
     * Whether the pasted config carries its own credential, endpoint or `{env:NAME}` reference, which the claim
     * keeps above the connection's (docs/workspace.md). Read from the stored markers and the config text, never by
     * decrypting a key; only the list reads answer it, so a write's echo omits it.
     */
    readonly configOverridesConnection?: boolean;
}

/** What `configFor` answers: the row's type, the raw config the member pasted, its round limit, whether it is suspended and its runner class. */
export interface UserExecutorConfig {
    readonly type: string;
    readonly config: Record<string, unknown>;
    readonly gateFixRounds: number;
    readonly suspended: boolean;
    readonly runnerClass: string | null;
    /** The selected provider connection (docs/env.md); absent — not null — when the profile selects none, so a profile without one reads as it always did. */
    readonly providerConnectionId?: string;
}

/**
 * A member's legacy default-executor preference (issue 391): names a profile by scope and name. It applies only while no
 * configured default does (`selectDefault`, which names the profile by stable id), and `resolvedDefault`'s chain covers
 * a preference whose profile was removed.
 */
export interface ExecutorDefault {
    readonly scope: ExecutorScope;
    readonly name: string;
}

/**
 * What a task naming no executor runs on (`resolvedDefault`): a profile by scope and name, or an agent default the task
 * is frozen with — its agent type and model, and whether the member's own row or the organization's won.
 */
export type ResolvedDefault =
    | ({ readonly kind: 'profile' } & ExecutorDefault)
    | ({ readonly kind: 'agent'; readonly from: 'personal' | 'org' } & AgentDefault);

export interface UserExecutorStore {
    /**
     * Replaces a member's whole PERSONAL executor list.
     *
     * The body of `PUT /api/workspace/executors` is the entire list, so replaying the same body changes
     * nothing, which is what makes the route a PUT. A surviving row is updated in place under its id; a row
     * the body omits is deleted — a row tracks no disk state, so "keeping" an omitted executor would only contradict the body the member just sent. Org-scope rows are never
     * touched: they belong to the organization, and the admin CRUD routes are their only writers.
     */
    replace(userId: string, executors: readonly PersonalExecutorEntry[]): Promise<void>;
    /** Removes one of the member's OWN personal rows by id. False when the id names no such row. */
    removePersonal(userId: string, id: string): Promise<boolean>;
    /** Suspends or resumes one of the member's OWN personal rows. Null when the id names no such row. */
    setPersonalSuspended(userId: string, id: string, suspended: boolean): Promise<ExecutorProfile | null>;
    /** Suspends or resumes an org-scope row. Null when the id names no org row of this organization. */
    setOrgSuspended(id: string, suspended: boolean): Promise<ExecutorProfile | null>;
    list(userId: string): Promise<ExecutorProfile[]>;
    /**
     * The whole list WITH its pasted configs — the on-demand read the workspace's edit dialog
     * opens with. `list()` deliberately never selects `config` because it feeds a two-second poll;
     * this is the member asking for their own rows back so an executor can be edited, and it is
     * fetched once per dialog open, never polled.
     */
    listWithConfigs(userId: string): Promise<(ExecutorProfile & { config: Record<string, unknown> })[]>;
    /**
     * The one executor row a task selection names, WITH its pasted config — the claim-time read
     * the job store makes to hand a runner the member's own executor configuration
     * (`OPENCODE_CONFIG_CONTENT` / `CLAUDE_CODE_CONFIG_CONTENT`). The scope disambiguates a
     * personal and an org row sharing a name; there is no cross-scope fallback, because a
     * selection names its scope explicitly. `list()` deliberately never selects `config`, because
     * it feeds a two-second poll; this is the one read that must, and it runs on the claim's
     * transaction for the same reason the env resolver does: a claim holds one connection, so
     * enough concurrent claims can never wedge the pool against itself.
     */
    configFor(
        userId: string,
        name: string,
        scope?: ExecutorScope,
        exec?: Sql | TransactionSql
    ): Promise<UserExecutorConfig | null>;
    /**
     * `configFor` for the claim: the same row with every stored credential resolved from the secret
     * store. A read that is not a confirmed value throws, so the claim rolls back and stays queued.
     */
    claimConfigFor(
        userId: string,
        name: string,
        scope: ExecutorScope,
        exec: Sql | TransactionSql
    ): Promise<UserExecutorConfig | null>;
    /**
     * Settles once the organization's profiles are in stored form (the plaintext conversion done).
     * A claim awaits it BEFORE opening its transaction: the conversion takes pool connections.
     */
    ready(): Promise<void>;

    /** The organization's profiles, in management order. Never carries configs — poll-shaped. */
    listOrg(): Promise<ExecutorProfile[]>;
    /** The org profiles WITH configs — the admin list's read, the edit dialog's opening state. */
    listOrgWithConfigs(): Promise<(ExecutorProfile & { config: Record<string, unknown> })[]>;
    /** Creates an org-scope row. Duplicate name in the org scope surfaces as the name index. */
    createOrg(input: {
        name: string;
        type: string;
        config: Record<string, unknown>;
        gateFixRounds?: number;
        runnerClass?: string | null;
        providerConnectionId?: string | null;
        createdBy: string;
    }): Promise<ExecutorProfile & { config: Record<string, unknown> }>;
    /**
     * Edits an org-scope row in place. Null when the id names no org row of this organization —
     * a personal row is not addressable through the org CRUD surface. An omitted `runnerClass` keeps the
     * row's; null clears it.
     */
    updateOrg(
        id: string,
        patch: {
            name?: string;
            type?: string;
            config?: Record<string, unknown>;
            gateFixRounds?: number;
            runnerClass?: string | null;
            /** Omitted keeps the row's connection; null clears it. */
            providerConnectionId?: string | null;
        }
    ): Promise<(ExecutorProfile & { config: Record<string, unknown> }) | null>;
    /**
     * Removes an org-scope row. False when the id names no org row of this organization. Selections naming it refuse the
     * delete (`ExecutorDefaultProtectedError`, with counts) unless `resolution` clears them or re-points them.
     */
    deleteOrg(id: string, resolution?: DefaultResolution): Promise<boolean>;
    /**
     * Moves one row between scopes: a member's own personal row up to org scope (issue 391), or an
     * org row down into the calling admin's personal list. Only the caller's OWN personal row
     * promotes — the update's WHERE clause holds that, so the route's caller is the enforcement.
     * A name already taken in the target scope surfaces as the name index. A demotion clears the
     * row's runner class: a personal profile names none. The row's provider connection must be visible in the target
     * scope: a promotion refuses a personal one (`ExecutorConnectionRefusedError`). A demotion is refused while the
     * organization default, or another member's default, names the row, unless `resolution` clears or re-points them.
     */
    changeScope(
        id: string,
        to: ExecutorScope,
        userId: string,
        resolution?: DefaultResolution
    ): Promise<ExecutorProfile | null>;
    /** How many org-scope rows the organization holds — the cap check's read. */
    orgCount(): Promise<number>;

    /** The member's legacy name-keyed preference, verbatim — a read only; nothing writes it any more. Null when unset. */
    defaultOf(userId: string): Promise<ExecutorDefault | null>;
    /** The configured default `owner` holds (a member's id; null: the organization's), by stable id. Null when none. */
    selectedDefault(owner: string | null): Promise<DefaultSelection | null>;
    /**
     * Configures `executorId` as `owner`'s default, replacing any earlier one: an organization default may name an
     * organization profile only, a member's their own or an organization's. A target the owner may not select is
     * `ExecutorDefaultNotFoundError`, a suspended one `ExecutorSuspendedError`; nothing is written then.
     */
    selectDefault(owner: string | null, executorId: string): Promise<DefaultSelection>;
    /** `selectDefault` inside a transaction the caller holds, so a setup writes it beside the profile it selects. */
    selectDefaultInTx(tx: TransactionSql, owner: string | null, executorId: string): Promise<DefaultSelection>;
    /** Clears `owner`'s configured default. False when there was none. */
    clearDefault(owner: string | null): Promise<boolean>;
    /**
     * What a task naming no executor runs on: the member's configured default, then the organization's, each by stable id
     * — and one that is suspended refuses (`ConfiguredDefaultUnusableError`) instead of falling through. Without a
     * configured default, the legacy chain: the stored preference
     * while it still resolves to an ACTIVE row, then the member's agent default, then the
     * organization's agent default, then the first active personal row by position, then the first
     * active org row by position, then null. A removed or suspended profile's preference falls
     * through — it is never silently re-pointed at another row, and a suspended one stays stored so
     * resuming restores it. A failed read throws; it is never "no default".
     */
    resolvedDefault(userId: string): Promise<ResolvedDefault | null>;

    /** The organization's agent default and the member's own, each null when unset. */
    agentDefaults(userId: string): Promise<AgentDefaults>;
    /** Writes the agent default `owner` names — a member's id, or null for the organization's. */
    setAgentDefault(owner: string | null, value: AgentDefault): Promise<void>;
    /** `setAgentDefault` inside a transaction the caller holds, so a save can write it beside other rows. */
    setAgentDefaultInTx(tx: TransactionSql, owner: string | null, value: AgentDefault): Promise<void>;
    /** The agent default `owner` names, read and locked inside a transaction the caller holds; null when unset. */
    agentDefaultInTx(tx: TransactionSql, owner: string | null): Promise<AgentDefault | null>;
    /** Removes the agent default `owner` names (null: the organization's). False when there was none. */
    deleteAgentDefault(owner: string | null): Promise<boolean>;
}

interface Row {
    id: string;
    name: string;
    type: string;
    created_at: Date;
    updated_at: Date;
    gate_fix_rounds: number;
    created_by: string | null;
    suspended: boolean;
    runner_class: string | null;
    provider_connection_id: string | null;
    overrides_connection?: boolean;
}

const toExecutorProfile = (row: Row): ExecutorProfile => ({
    id: row.id,
    name: row.name,
    type: row.type,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    gateFixRounds: row.gate_fix_rounds,
    createdBy: row.created_by,
    suspended: row.suspended,
    runnerClass: row.runner_class,
    providerConnectionId: row.provider_connection_id,
    ...(row.overrides_connection === undefined ? {} : { configOverridesConnection: row.overrides_connection }),
});

/**
 * The by-id writes (issue 440) address a row by its id AND its owner — `owner` null is the org
 * scope — so another member's id, an org id reached through the personal door and an id from
 * another organization all match nothing.
 */
async function deleteOwnedRow(
    deps: ExecutorCredentialDeps,
    { id, owner, resolution }: { id: string; owner: string | null; resolution?: DefaultResolution }
): Promise<boolean> {
    const rows = await refusingSelected<{ secret_refs: StoredCredential[] }[]>(() =>
        deps.sql.begin(async (tx): Promise<{ secret_refs: StoredCredential[] }[]> => {
            const [target] = await tx<{ id: string; name: string }[]>`
                select id, name from executor_profile
                where org_id = ${deps.orgId} and id = ${id} and user_id is not distinct from ${owner}
                for update
            `;
            if (!target) return [];
            // A default naming it must be cleared or replaced first: the member's own for a personal row, every
            // selection of an organization row — refused with counts unless `resolution` says what becomes of them.
            if (owner === null)
                await resolveOrphanedSelections(tx, deps.orgId, target, resolution ? { resolution } : {});
            else await assertUnselected(tx, deps.orgId, [target], owner);
            return tx<{ secret_refs: StoredCredential[] }[]>`
                delete from executor_profile where org_id = ${deps.orgId} and id = ${id}
                returning secret_refs
            `;
        })
    );
    await retireCredentials(deps, storedOf(rows));
    return rows.length > 0;
}

/** Runs a write whose deferred reference may refuse at commit: a profile a default named after the pre-check ran. */
async function refusingSelected<T>(write: () => Promise<T>): Promise<T> {
    try {
        return await write();
    } catch (error) {
        if (!isSelectionReferenceViolation(error)) throw error;
        throw new ExecutorDefaultProtectedError('', protectedMessage());
    }
}

async function setSuspendedRow(
    sql: Sql,
    { orgId, id, owner, suspended }: { orgId: string; id: string; owner: string | null; suspended: boolean }
): Promise<ExecutorProfile | null> {
    const rows = await sql<Row[]>`
        update executor_profile set suspended = ${suspended}, updated_at = now()
        where org_id = ${orgId} and id = ${id} and user_id is not distinct from ${owner}
        returning id, name, type, created_at, updated_at, gate_fix_rounds, created_by, suspended, runner_class, provider_connection_id
    `;
    return rows[0] ? toExecutorProfile(rows[0]) : null;
}

/**
 * `configFor`'s claim-time read. The scope's ownership plus the name names at most one row — the org
 * scope keys on a NULL owner, the personal scope on the caller's id — so the read cannot be ambiguous,
 * and a name that exists in the other scope is simply not this selection's answer.
 */
async function readConfig(
    exec: Sql,
    { orgId, owner, name }: { orgId: string; owner: string | null; name: string }
): Promise<UserExecutorConfig | null> {
    const rows = await exec<
        {
            type: string;
            config: Record<string, unknown>;
            gate_fix_rounds: number;
            suspended: boolean;
            runner_class: string | null;
            provider_connection_id: string | null;
        }[]
    >`
        select type, config, gate_fix_rounds, suspended, runner_class, provider_connection_id
        from executor_profile
        where org_id = ${orgId} and user_id is not distinct from ${owner} and name = ${name}
    `;
    const row = rows[0];
    return row
        ? {
              type: row.type,
              config: row.config,
              gateFixRounds: row.gate_fix_rounds,
              suspended: row.suspended,
              runnerClass: row.runner_class,
              ...selectedOf(row.provider_connection_id),
          }
        : null;
}

/** The next `position` at the end of the given scope's list — org rows and each member's rows. */
async function nextPosition(exec: Sql | TransactionSql, orgId: string, userId: string | null): Promise<number> {
    const rows = await exec<{ next: number }[]>`
        select coalesce(max(position) + 1, 0) as next
        from executor_profile
        where org_id = ${orgId} and user_id is not distinct from ${userId}
    `;
    return rows[0]?.next ?? 0;
}

type ConfiguredRow = Row & { config: Record<string, unknown> };

/** `claimConfigFor`'s read: the selected row with its stored credentials resolved. */
async function claimConfigRow(
    deps: ExecutorCredentialDeps,
    { owner, name }: { owner: string | null; name: string },
    exec: Sql | TransactionSql
): Promise<UserExecutorConfig | null> {
    const rows = await (exec as Sql)<
        (Pick<
            ConfiguredRow,
            'type' | 'config' | 'gate_fix_rounds' | 'suspended' | 'runner_class' | 'provider_connection_id'
        > & {
            secret_refs: StoredCredential[];
        })[]
    >`
        select type, config, secret_refs, gate_fix_rounds, suspended, runner_class, provider_connection_id
        from executor_profile
        where org_id = ${deps.orgId} and user_id is not distinct from ${owner} and name = ${name}
    `;
    const row = rows[0];
    if (!row) return null;
    // A suspended profile's config never travels, so its credentials are not read.
    const config = row.suspended
        ? row.config
        : await resolveCredentials(deps.secrets, deps.orgId, row.config, row.secret_refs);
    return {
        type: row.type,
        config,
        gateFixRounds: row.gate_fix_rounds,
        suspended: row.suspended,
        runnerClass: row.runner_class,
        ...selectedOf(row.provider_connection_id),
    };
}

/** `createOrg`'s write: a new org row, its config sealed (executor-credentials.ts). */
async function insertOrgRow(
    deps: ExecutorCredentialDeps,
    input: Parameters<UserExecutorStore['createOrg']>[0]
): Promise<ConfiguredRow> {
    const rows = await writeSealed(deps, [input.config], async (tx, sealedOf) => {
        const [sealed] = sealedOf([]);
        await assertConnectionSelection(tx, deps.orgId, {
            owner: null,
            connectionId: input.providerConnectionId ?? null,
            type: input.type,
            model: modelOf(input.config),
            previousConnectionId: null,
        });
        const position = await nextPosition(tx, deps.orgId, null);
        return tx<ConfiguredRow[]>`
            insert into executor_profile
                (org_id, user_id, name, type, config, secret_refs, gate_fix_rounds, position, created_by, runner_class,
                 provider_connection_id)
            values (
                ${deps.orgId}, null, ${input.name}, ${input.type}, ${tx.json(sealed!.config as never)},
                ${tx.json(sealed!.secretRefs as never)}, ${input.gateFixRounds ?? DEFAULT_GATE_FIX_ROUNDS},
                ${position}, ${input.createdBy}, ${input.runnerClass ?? null}, ${input.providerConnectionId ?? null}
            )
            returning id, name, type, created_at, updated_at, gate_fix_rounds, created_by, suspended, runner_class, provider_connection_id, config
        `;
    });
    const row = rows[0];
    if (!row) throw new Error('createOrg returned no row');
    return row;
}

/** `updateOrg`'s write: the org row edited in place, a new config sealed against the row's own credentials. */
async function updateOrgRow(
    deps: ExecutorCredentialDeps,
    id: string,
    patch: Parameters<UserExecutorStore['updateOrg']>[1]
): Promise<ConfiguredRow | null> {
    const { orgId } = deps;
    const { config } = patch;
    const rows = await writeSealed(deps, config ? [config] : [], async (tx, sealedOf) => {
        const previous = await lockOrgRowForUpdate(tx, orgId, { id, patch });
        if (!previous) return [];
        const [sealed] = config ? sealedOf(storedOf([previous])) : [];
        return tx<ConfiguredRow[]>`
            update executor_profile set
                name = coalesce(${patch.name ?? null}, name),
                type = coalesce(${patch.type ?? null}, type),
                config = coalesce(${sealed ? tx.json(sealed.config as never) : null}, config),
                secret_refs = coalesce(${sealed ? tx.json(sealed.secretRefs as never) : null}, secret_refs),
                gate_fix_rounds = coalesce(${patch.gateFixRounds ?? null}, gate_fix_rounds),
                runner_class = case when ${patch.runnerClass !== undefined} then ${patch.runnerClass ?? null}
                                    else runner_class end,
                provider_connection_id = ${previous.connectionId},
                updated_at = now()
            where org_id = ${orgId} and id = ${id} and user_id is null
            returning id, name, type, created_at, updated_at, gate_fix_rounds, created_by, suspended, runner_class, provider_connection_id, config
        `;
    });
    return rows[0] ?? null;
}

/** `resolvedDefault`'s chain over the store's own reads, in the order the interface documents. */
async function resolveDefault(
    store: Pick<UserExecutorStore, 'defaultOf' | 'configFor' | 'agentDefaults' | 'list' | 'listOrg'>,
    userId: string,
    configuredOf: () => Promise<DefaultSelection | null>
): Promise<ResolvedDefault | null> {
    const selected = await configuredOf();
    if (selected) return { kind: 'profile', scope: selected.scope, name: selected.name };
    const stored = await store.defaultOf(userId);
    const configured = stored ? await store.configFor(userId, stored.name, stored.scope) : null;
    if (stored && configured && !configured.suspended) {
        return { kind: 'profile', ...stored };
    }
    // An agent default comes before any profile the member never chose: the member's own, then the org's.
    const agents = await store.agentDefaults(userId);
    if (agents.personal) return { kind: 'agent', ...agents.personal, from: 'personal' };
    if (agents.org) return { kind: 'agent', ...agents.org, from: 'org' };
    // The fallback chain, deterministic: first active personal row by position, then first
    // active org row. A member who never chose keeps "selected first on new tasks" semantics.
    const personal = (await store.list(userId)).find((row) => !row.suspended);
    if (personal) return { kind: 'profile', scope: USER_SCOPE, name: personal.name };
    const orgRow = (await store.listOrg()).find((row) => !row.suspended);
    if (orgRow) return { kind: 'profile', scope: ORG_SCOPE, name: orgRow.name };
    return null;
}

/** The organization is bound at construction: one store serves one organization. */
export function createUserExecutorStore({
    sql,
    orgId,
    ready,
    secrets,
    secretLog,
    writeDeadlineMs = 30_000,
    cleanupDeadlineMs = 10_000,
}: {
    sql: Sql;
    orgId: string;
    ready?: Promise<unknown>;
    /** Holds every credential-shaped value of a profile's config (docs/workspace.md). */
    secrets: SecretStore;
    /** The secret store's diagnostic sink: a compensation that could not finish is reported here. */
    secretLog: (diagnostic: SecretDiagnostic) => void;
    /** Bounds a save's creates; compensation runs under its own `cleanupDeadlineMs`. */
    writeDeadlineMs?: number;
    cleanupDeadlineMs?: number;
}): UserExecutorStore {
    const deps: ExecutorCredentialDeps = { sql, orgId, secrets, secretLog, writeDeadlineMs, cleanupDeadlineMs };
    // Rows saved before credentials moved to the store are converted before the first read.
    const gate = convertedGate(deps, ready);

    return {
        async replace(userId, executors) {
            await gate();
            await refusingSelected(() =>
                writeSealed(
                    deps,
                    executors.map((executor) => executor.config),
                    (tx, sealedOf) => replacePersonalRows(tx, { orgId, userId }, executors, sealedOf)
                )
            );
        },

        async removePersonal(userId, id) {
            await gate();
            return deleteOwnedRow(deps, { id, owner: userId });
        },

        async setPersonalSuspended(userId, id, suspended) {
            await gate();
            return setSuspendedRow(sql, { orgId, id, owner: userId, suspended });
        },

        async setOrgSuspended(id, suspended) {
            await gate();
            return setSuspendedRow(sql, { orgId, id, owner: null, suspended });
        },

        async list(userId) {
            await gate();
            // `config` is deliberately not selected: the routes echo these rows on every poll, and
            // pasted config may hold credentials.
            const rows = await sql<Row[]>`
                select id, name, type, created_at, updated_at, gate_fix_rounds, created_by, suspended, runner_class, provider_connection_id,
                    (jsonb_array_length(secret_refs) > 0 or config::text ~* '[{]env:|"[a-z_]*base_?url"') as overrides_connection
                from executor_profile
                where org_id = ${orgId} and user_id = ${userId}
                order by position asc, name asc
            `;
            return rows.map(toExecutorProfile);
        },

        async listWithConfigs(userId) {
            await gate();
            const rows = await sql<(Row & { config: Record<string, unknown> })[]>`
                select id, name, type, created_at, updated_at, gate_fix_rounds, created_by, suspended, runner_class, provider_connection_id, config,
                    (jsonb_array_length(secret_refs) > 0 or config::text ~* '[{]env:|"[a-z_]*base_?url"') as overrides_connection
                from executor_profile
                where org_id = ${orgId} and user_id = ${userId}
                order by position asc, name asc
            `;
            return rows.map((row) => ({ ...toExecutorProfile(row), config: row.config }));
        },

        async configFor(userId, name, scope = USER_SCOPE, exec = sql) {
            await gate();
            return readConfig(exec as Sql, { orgId, owner: scope === USER_SCOPE ? userId : null, name });
        },

        ready: gate,

        async claimConfigFor(userId, name, scope, exec) {
            // Never the conversion gate: it needs a pool connection while the claim's transaction
            // holds one. The claim awaits `ready()` before opening it.
            if (ready) await ready;
            return claimConfigRow(deps, { owner: scope === USER_SCOPE ? userId : null, name }, exec);
        },

        async listOrg() {
            await gate();
            const rows = await sql<Row[]>`
                select id, name, type, created_at, updated_at, gate_fix_rounds, created_by, suspended, runner_class, provider_connection_id,
                    (jsonb_array_length(secret_refs) > 0 or config::text ~* '[{]env:|"[a-z_]*base_?url"') as overrides_connection
                from executor_profile
                where org_id = ${orgId} and user_id is null
                order by position asc, name asc
            `;
            return rows.map(toExecutorProfile);
        },

        async listOrgWithConfigs() {
            await gate();
            const rows = await sql<(Row & { config: Record<string, unknown> })[]>`
                select id, name, type, created_at, updated_at, gate_fix_rounds, created_by, suspended, runner_class, provider_connection_id, config,
                    (jsonb_array_length(secret_refs) > 0 or config::text ~* '[{]env:|"[a-z_]*base_?url"') as overrides_connection
                from executor_profile
                where org_id = ${orgId} and user_id is null
                order by position asc, name asc
            `;
            return rows.map((row) => ({ ...toExecutorProfile(row), config: row.config }));
        },

        async createOrg(input) {
            await gate();
            const row = await insertOrgRow(deps, input);
            return { ...toExecutorProfile(row), config: row.config };
        },

        async updateOrg(id, patch) {
            await gate();
            const row = await updateOrgRow(deps, id, patch);
            return row ? { ...toExecutorProfile(row), config: row.config } : null;
        },

        async deleteOrg(id, resolution) {
            await gate();
            return deleteOwnedRow(deps, { id, owner: null, ...(resolution ? { resolution } : {}) });
        },

        async changeScope(id, to, userId, resolution) {
            await gate();
            if (to === USER_SCOPE) {
                // Org row down into the calling admin's personal list, at the end of it.
                const rows = await refusingSelected(() =>
                    sql.begin(async (tx) => {
                        await assertMovedSelection(tx, orgId, { id, from: null, to: userId });
                        // An organization default cannot become one member's personal profile, and other members'
                        // defaults would be orphaned: refused unless the request resolves them. The caller's own
                        // selection stays valid on their own row.
                        const [moving] = await tx<{ id: string; name: string }[]>`
                        select id, name from executor_profile where org_id = ${orgId} and id = ${id} and user_id is null
                    `;
                        if (moving) {
                            await resolveOrphanedSelections(tx, orgId, moving, {
                                keep: userId,
                                ...(resolution ? { resolution } : {}),
                            });
                        }
                        const position = await nextPosition(tx, orgId, userId);
                        return tx<Row[]>`
                        update executor_profile set
                            user_id = ${userId}, position = ${position}, created_by = null, runner_class = null,
                            updated_at = now()
                        where org_id = ${orgId} and id = ${id} and user_id is null
                        returning id, name, type, created_at, updated_at, gate_fix_rounds, created_by, suspended, runner_class, provider_connection_id
                    `;
                    })
                );
                const row = rows[0];
                return row ? toExecutorProfile(row) : null;
            }
            // The caller's OWN personal row up to org scope. `user_id = ${userId}` in the WHERE is
            // the ownership enforcement at the row: another member's row does not match, and the
            // route's caller check rests on this.
            const rows = await sql.begin(async (tx) => {
                await assertMovedSelection(tx, orgId, { id, from: userId, to: null });
                const position = await nextPosition(tx, orgId, null);
                return tx<Row[]>`
                    update executor_profile set
                        user_id = null, position = ${position}, created_by = ${userId}, updated_at = now()
                    where org_id = ${orgId} and id = ${id} and user_id = ${userId}
                    returning id, name, type, created_at, updated_at, gate_fix_rounds, created_by, suspended, runner_class, provider_connection_id
                `;
            });
            const row = rows[0];
            return row ? toExecutorProfile(row) : null;
        },

        async orgCount() {
            await gate();
            const rows = await sql<{ count: number }[]>`
                select count(*)::int as count from executor_profile
                where org_id = ${orgId} and user_id is null
            `;
            return rows[0]?.count ?? 0;
        },

        async defaultOf(userId) {
            await gate();
            const rows = await sql<{ scope: ExecutorScope; name: string }[]>`
                select scope, name from user_executor_default
                where org_id = ${orgId} and user_id = ${userId}
            `;
            const row = rows[0];
            return row ? { scope: row.scope, name: row.name } : null;
        },

        ...selectionMethods(sql, orgId, gate),

        async resolvedDefault(userId) {
            await gate();
            return resolveDefault(this, userId, () => resolveConfiguredDefault(sql, orgId, userId));
        },

        ...agentDefaultMethods(sql, orgId, gate),
    };
}
