import type { Sql, TransactionSql } from 'postgres';
import { type ExecutorScope, ORG_SCOPE, USER_SCOPE } from '@factory-ai/core';

/**
 * The scoped, stable default-executor selection (migration 169): one row per owner — a member, or the organization —
 * naming a profile by its id. These helpers take the executor and the transaction they run in, so a caller composes a
 * selection with other writes; `user-executor-store.ts` binds them to one organization.
 */

/** A configured default as the store reads it: the profile it names, resolved to its current scope and name. */
export interface DefaultSelection {
    /** Null: the organization's selection. */
    readonly owner: string | null;
    readonly executorId: string;
    readonly scope: ExecutorScope;
    readonly name: string;
    readonly suspended: boolean;
}

/** `selectDefault`'s refusal when the target is not one the owner may select: no such profile, or another member's. The route answers 404. */
export class ExecutorDefaultNotFoundError extends Error {}

/** `selectDefault`'s other refusal (issue 440): the target is suspended. The route answers 409. */
export class ExecutorSuspendedError extends Error {}

/** How many selections still name an executor: the organization's, and members' own (a count, never who). */
export interface SelectionCounts {
    readonly organization: boolean;
    readonly members: number;
}

/**
 * A write that would delete, omit or move a profile a default still names. Never cascaded and never released silently:
 * the owner clears or replaces the default first, or the request carries an explicit `DefaultResolution`. The route
 * answers 409 with the counts in the message.
 */
export class ExecutorDefaultProtectedError extends Error {
    constructor(
        readonly executorId: string,
        message: string,
        readonly selections: SelectionCounts = { organization: false, members: 0 }
    ) {
        super(message);
        this.name = 'ExecutorDefaultProtectedError';
    }
}

/**
 * The explicit answer to the selections naming an organization executor that is being deleted or moved to personal
 * scope: clear them all, or re-point them all at another active organization executor, in the same transaction.
 */
export type DefaultResolution = { readonly clear: true } | { readonly replaceWith: string };

/**
 * A personal save naming an executor id the caller does not own, or one id twice. Identity is never guessed from the
 * name once an id is sent. The route answers 400.
 */
export class ExecutorIdentityError extends Error {}

/**
 * A configured default that cannot run a task now: its profile is suspended or no longer reachable by the member. The
 * resolution refuses with it, never falling through to another default. Resuming the profile restores the default.
 */
export class ConfiguredDefaultUnusableError extends Error {
    constructor(
        readonly reason: 'suspended' | 'missing',
        readonly scope: ExecutorScope,
        readonly executorName: string,
        message: string
    ) {
        super(message);
        this.name = 'ConfiguredDefaultUnusableError';
    }
}

type Exec = Sql | TransactionSql;

/** postgres' foreign-key violation, which the deferred reference raises at commit for a profile a selection still names. */
const FOREIGN_KEY_VIOLATION = '23503';
const SELECTION_FK = 'executor_default_selection_executor_fk';

/** Whether the error is the selection's own reference refusing a delete: a race the store's pre-check lost. */
export const isSelectionReferenceViolation = (error: unknown): boolean =>
    (error as { code?: string }).code === FOREIGN_KEY_VIOLATION &&
    (error as { constraint_name?: string }).constraint_name === SELECTION_FK;

const memberCount = (count: number) => (count === 1 ? `${count} member` : `${count} members`);

/** The refusal naming what still selects the executor: the organization default and a count of members, no identities. */
export const selectedMessage = (name: string, { organization, members }: SelectionCounts) => {
    const holders = [
        ...(organization ? ['the organization default'] : []),
        ...(members > 0 ? [`the default of ${memberCount(members)}`] : []),
    ].join(' and ');
    return `The executor "${name}" is ${holders}; clear or replace ${organization || members > 1 ? 'them' : 'it'} first (clearDefaults, or replaceDefaultsWith an organization executor)`;
};

export const protectedMessage = (name?: string) =>
    `${name === undefined ? 'An executor in this change' : `The executor "${name}"`} is a default executor; select or clear another default before removing or moving it`;

interface SelectionRow {
    owner_id: string | null;
    executor_id: string;
    name: string;
    user_id: string | null;
    suspended: boolean;
}

const toSelection = (row: SelectionRow): DefaultSelection => ({
    owner: row.owner_id,
    executorId: row.executor_id,
    scope: row.user_id === null ? ORG_SCOPE : USER_SCOPE,
    name: row.name,
    suspended: row.suspended,
});

/** The selection `owner` holds (null: the organization's), with the profile's current scope and name; null when none. */
export async function readSelection(exec: Exec, orgId: string, owner: string | null): Promise<DefaultSelection | null> {
    const [row] = await (exec as Sql)<SelectionRow[]>`
        select s.owner_id, s.executor_id, p.name, p.user_id, p.suspended
        from executor_default_selection s
        join executor_profile p on p.org_id = s.org_id and p.id = s.executor_id
        where s.org_id = ${orgId} and s.owner_id is not distinct from ${owner}
    `;
    return row ? toSelection(row) : null;
}

/**
 * Selects `executorId` as `owner`'s default inside the caller's transaction. The target is read `for share`, so a
 * concurrent deletion waits for this transaction and a deletion that already committed is a plain "not found": no
 * interleaving leaves a selection dangling. An organization default may name an organization profile only; a member's
 * may name their own or an organization profile.
 */
export async function selectDefaultInTx(
    tx: TransactionSql,
    orgId: string,
    owner: string | null,
    executorId: string
): Promise<DefaultSelection> {
    const [target] = await tx<{ name: string; user_id: string | null; suspended: boolean }[]>`
        select name, user_id, suspended from executor_profile
        where org_id = ${orgId} and id = ${executorId}
          and (user_id is null or user_id is not distinct from ${owner})
        for share
    `;
    if (!target)
        throw new ExecutorDefaultNotFoundError(`No executor ${executorId} is available to select as a default`);
    const scope = target.user_id === null ? ORG_SCOPE : USER_SCOPE;
    if (target.suspended) throw new ExecutorSuspendedError(`The ${scope} executor "${target.name}" is suspended`);
    await tx`
        insert into executor_default_selection (org_id, owner_id, executor_id)
        values (${orgId}, ${owner}, ${executorId})
        on conflict (org_id, coalesce(owner_id, '00000000-0000-0000-0000-000000000000'::uuid)) do update
        set executor_id = excluded.executor_id, updated_at = now()
    `;
    return { owner, executorId, scope, name: target.name, suspended: false };
}

/** Clears `owner`'s selection. False when there was none. */
export async function clearSelection(exec: Exec, orgId: string, owner: string | null): Promise<boolean> {
    const rows = await (exec as Sql)`
        delete from executor_default_selection
        where org_id = ${orgId} and owner_id is not distinct from ${owner}
        returning id
    `;
    return rows.length > 0;
}

/**
 * What a task naming no executor resolves to: the member's configured default, else the organization's, else null
 * (there is no fallback to a profile nobody chose). A configured default whose profile is suspended refuses (`ConfiguredDefaultUnusableError`)
 * instead of falling through, and so does a selection naming a profile the member can no longer reach.
 */
export async function resolveConfiguredDefault(
    exec: Exec,
    orgId: string,
    userId: string
): Promise<DefaultSelection | null> {
    const selection = (await readSelection(exec, orgId, userId)) ?? (await readSelection(exec, orgId, null));
    if (!selection) return null;
    if (selection.suspended) {
        throw new ConfiguredDefaultUnusableError(
            'suspended',
            selection.scope,
            selection.name,
            `The default ${selection.scope} executor "${selection.name}" is suspended; resume it or select another default`
        );
    }
    // A personal profile is reachable by its owner only. The writers keep this true; a violation is a refusal, not a fallback.
    if (selection.scope === USER_SCOPE && selection.owner !== userId) {
        throw new ConfiguredDefaultUnusableError(
            'missing',
            selection.scope,
            selection.name,
            `The default executor "${selection.name}" is not available to you; select another default`
        );
    }
    return selection;
}

/**
 * The guard every write that removes, omits or moves a profile runs inside its transaction: refuses while a selection by
 * `owner` (null: the organization's) still names one of `targets`. The profiles are locked first, so a concurrent
 * selection of one waits for this transaction instead of slipping past the read; the deferred reference is the backstop
 * for any other order.
 */
export async function assertUnselected(
    tx: TransactionSql,
    orgId: string,
    targets: readonly { id: string; name: string }[],
    owner: string | null
): Promise<void> {
    if (targets.length === 0) return;
    const ids = targets.map((target) => target.id);
    await tx`select id from executor_profile where org_id = ${orgId} and id in ${tx(ids)} for update`;
    const [held] = await tx<{ executor_id: string }[]>`
        select executor_id from executor_default_selection
        where org_id = ${orgId} and executor_id in ${tx(ids)} and owner_id is not distinct from ${owner}
    `;
    if (!held) return;
    const target = targets.find((candidate) => candidate.id === held.executor_id)!;
    throw new ExecutorDefaultProtectedError(held.executor_id, protectedMessage(target.name));
}

/**
 * The guard an organization executor's deletion or move to personal scope runs inside its transaction. Selections naming
 * it — the organization's, and members' own except `keep`'s (the actor keeps their selection on the row they now own) —
 * refuse the write with their counts, unless `resolution` clears them or re-points them at `replaceWith`, which must be
 * an active organization executor other than the targets. Nothing is released without that explicit word. The
 * replacement is locked before the selections (profiles first, selections after, as the setup takes them), and the
 * selections are read `for update` and written under `executor_id = target`, so a default a member switches meanwhile
 * waits for this transaction and is never cleared or overwritten by it.
 */
export async function resolveOrphanedSelections(
    tx: TransactionSql,
    orgId: string,
    target: { id: string; name: string },
    options: { keep?: string; resolution?: DefaultResolution } = {}
): Promise<void> {
    await tx`select id from executor_profile where org_id = ${orgId} and id = ${target.id} for update`;
    // The lock order of every writer is profile rows first, selection rows after (the setup holds its executor and then
    // upserts its selection): the replacement is locked before the selections are, so no two writers wait crosswise.
    const { resolution } = options;
    const replacement =
        resolution && 'replaceWith' in resolution
            ? (
                  await tx<{ name: string; suspended: boolean }[]>`
                      select name, suspended from executor_profile
                      where org_id = ${orgId} and id = ${resolution.replaceWith} and id <> ${target.id} and user_id is null
                      for share
                  `
              )[0]
            : undefined;
    const held = (
        await tx<{ id: string; owner_id: string | null }[]>`
            select id, owner_id from executor_default_selection
            where org_id = ${orgId} and executor_id = ${target.id}
            for update
        `
    ).filter((row) => row.owner_id === null || row.owner_id !== options.keep);
    if (held.length === 0) return;
    if (!resolution) {
        const counts = {
            organization: held.some((row) => row.owner_id === null),
            members: held.filter((row) => row.owner_id !== null).length,
        };
        throw new ExecutorDefaultProtectedError(target.id, selectedMessage(target.name, counts), counts);
    }
    const ids = held.map((row) => row.id);
    if ('clear' in resolution) {
        // The rows are locked above, and the predicate still names what they were read for: a selection moved off the
        // target meanwhile is not this write's to clear.
        await tx`
            delete from executor_default_selection
            where org_id = ${orgId} and id in ${tx(ids)} and executor_id = ${target.id}
        `;
        return;
    }
    if (!replacement)
        throw new ExecutorDefaultNotFoundError('No other organization executor to replace the default with');
    if (replacement.suspended) {
        throw new ExecutorSuspendedError(`The organization executor "${replacement.name}" is suspended`);
    }
    await tx`
        update executor_default_selection set executor_id = ${resolution.replaceWith}, updated_at = now()
        where org_id = ${orgId} and id in ${tx(ids)} and executor_id = ${target.id}
    `;
}

/** The configured-default methods `UserExecutorStore` exposes, bound to one organization behind the store's gate. */
export function selectionMethods(sql: Sql, orgId: string, gate: () => Promise<void>) {
    return {
        async selectedDefault(owner: string | null) {
            await gate();
            return readSelection(sql, orgId, owner);
        },

        async selectDefault(owner: string | null, executorId: string) {
            await gate();
            return sql.begin((tx) => selectDefaultInTx(tx, orgId, owner, executorId));
        },

        async selectDefaultInTx(tx: TransactionSql, owner: string | null, executorId: string) {
            return selectDefaultInTx(tx, orgId, owner, executorId);
        },

        async clearDefault(owner: string | null) {
            await gate();
            return clearSelection(sql, orgId, owner);
        },
    };
}
