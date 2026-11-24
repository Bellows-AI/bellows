import { githubRepo, type RepoRef } from '@factory-ai/core';
import type { TransactionSql } from 'postgres';
import type { EnvVarRow, EnvVarStore } from '../src/db/env-var-store.js';
import { EnvScopeRefusal, stackEnv, stackNames } from '../src/db/env-var-store.js';
import { storeOutage } from './helpers-outage.js';

export interface MemoryEnvVarStore extends EnvVarStore {
    /**
     * Every row with its REAL values, scope columns included — what the routes' nulled echo
     * deliberately withholds.
     */
    rows(): {
        userId: string | null;
        owner: string | null;
        repoName: string | null;
        name: string;
        value: string;
        isSecret: boolean;
    }[];
    /** Set to make every method reject, standing in for an unreachable database. */
    broken: boolean;
}

/**
 * An in-memory EnvVarStore, for the same reason memoryUserExecutorStore exists: it keeps the
 * offline suite a no-database suite while still exercising the write-only echo, the keep-a-null-
 * secret replace rule and the stacking. The SQL behind it is covered by server/test-db, which
 * needs a container.
 */
export function memoryEnvVarStore(): MemoryEnvVarStore {
    interface Row {
        userId: string | null;
        owner: string | null;
        repoName: string | null;
        name: string;
        value: string;
        isSecret: boolean;
        updatedAt: string;
    }
    const rows: Row[] = [];
    const at = () => new Date().toISOString();

    const store: MemoryEnvVarStore = {
        broken: false,

        rows: () =>
            rows.map((r) => ({
                userId: r.userId,
                owner: r.owner,
                repoName: r.repoName,
                name: r.name,
                value: r.value,
                isSecret: r.isSecret,
            })),

        async listOrg() {
            return rows
                .filter((r) => r.userId === null && r.owner === null)
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(view);
        },

        async listWorkspace(userId) {
            return rows
                .filter((r) => r.userId === userId)
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(view);
        },

        async listRepo(repo) {
            const [owner, name] = repo.path.split('/');
            return rows
                .filter((r) => r.owner === owner && r.repoName === name)
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(view);
        },

        async listRepos() {
            const grouped: { repo: RepoRef; vars: EnvVarRow[] }[] = [];
            for (const row of rows.filter((r) => r.owner !== null).sort(compareRepoOrder)) {
                const repo = githubRepo(`${row.owner}/${row.repoName}`);
                let group = grouped.find((g) => g.repo.path === repo.path);
                if (!group) {
                    group = { repo, vars: [] };
                    grouped.push(group);
                }
                group.vars.push(view(row));
            }
            return grouped;
        },

        async replaceOrg(_actorId, vars) {
            replaceRows('org', vars);
        },

        async replaceWorkspace(userId, vars) {
            replaceRows({ userId }, vars);
        },

        async replaceRepo(_actorId, repo, vars) {
            const [owner, name] = repo.path.split('/') as [string, string];
            replaceRows({ owner, name }, vars);
        },

        async writeScoped(scope, write, _actorId, options = {}) {
            if (store.broken) throw storeOutage('database is unreachable');
            const key =
                scope.kind === 'org'
                    ? 'org'
                    : scope.kind === 'workspace'
                      ? { userId: scope.userId }
                      : { owner: scope.repo.path.split('/')[0]!, name: scope.repo.path.split('/')[1]! };
            const upsert = write.upsert.filter((v) => v.value !== null);
            const inScope = rows.filter((r) => matches(key, r));
            const lockedRemovals = options.removeOf?.(inScope.map((r) => r.name)) ?? [];
            const touched = new Set([...write.remove, ...lockedRemovals, ...upsert.map((v) => v.name)]);
            const resulting = [
                ...inScope
                    .filter((r) => !touched.has(r.name))
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((r) => ({ name: r.name, value: r.isSecret ? null : r.value, isSecret: r.isSecret })),
                ...upsert,
            ];
            const reason = options.validate?.(resulting) ?? null;
            if (reason !== null) throw new EnvScopeRefusal(reason);
            // The hook's writes are the caller's concern; the double has no transaction to hand it.
            await options.alsoInTx?.(undefined as unknown as TransactionSql);
            for (let i = rows.length - 1; i >= 0; i -= 1) {
                if (matches(key, rows[i]!) && touched.has(rows[i]!.name)) rows.splice(i, 1);
            }
            for (const v of upsert) {
                rows.push({
                    ...scopeColumns(key),
                    name: v.name,
                    value: v.value as string,
                    isSecret: v.isSecret,
                    updatedAt: at(),
                });
            }
        },

        async resolveFor({ userId, repo }, _exec) {
            const pick = (list: Row[]): Record<string, string> =>
                Object.fromEntries(list.map((r) => [r.name, r.value]));
            const [owner, name] = repo ? repo.path.split('/') : [null, null];
            return stackEnv(
                pick(rows.filter((r) => r.userId === null && r.owner === null)),
                pick(userId ? rows.filter((r) => r.userId === userId) : []),
                pick(owner && name ? rows.filter((r) => r.owner === owner && r.repoName === name) : [])
            );
        },

        async namesFor({ userId, repo }, options = {}) {
            if (store.broken) throw storeOutage('database is unreachable');
            const [owner, name] = repo ? repo.path.split('/') : [null, null];
            const namesOf = (list: Row[]) => list.map((r) => r.name);
            return stackNames(
                [
                    namesOf(rows.filter((r) => r.userId === null && r.owner === null)),
                    namesOf(userId ? rows.filter((r) => r.userId === userId) : []),
                    namesOf(owner && name ? rows.filter((r) => r.owner === owner && r.repoName === name) : []),
                ],
                options.agentType
            );
        },
    };

    function view(row: Row): EnvVarRow {
        return {
            name: row.name,
            // The write-only echo, exactly as the SQL selects it.
            value: row.isSecret ? null : row.value,
            isSecret: row.isSecret,
            updatedAt: row.updatedAt,
        };
    }

    function compareRepoOrder(a: Row, b: Row): number {
        return (
            a.owner!.localeCompare(b.owner!) || a.repoName!.localeCompare(b.repoName!) || a.name.localeCompare(b.name)
        );
    }

    /** The keep-a-null-secret replace, mirroring the store's transaction semantics. */
    function replaceRows(
        scope: 'org' | { userId: string } | { owner: string; name: string },
        vars: readonly { name: string; value: string | null; isSecret: boolean }[]
    ): void {
        if (store.broken) throw storeOutage('database is unreachable');
        const inScope = (row: Row): boolean => matches(scope, row);
        const columns = scopeColumns(scope);
        const keep = new Set(vars.filter((v) => v.isSecret && v.value === null).map((v) => v.name));
        for (let i = rows.length - 1; i >= 0; i -= 1) {
            if (inScope(rows[i]!) && !keep.has(rows[i]!.name)) rows.splice(i, 1);
        }
        for (const v of vars) {
            if (v.value === null) continue;
            rows.push({
                ...columns,
                name: v.name,
                value: v.value,
                isSecret: v.isSecret,
                updatedAt: at(),
            });
        }
    }

    function matches(scope: 'org' | { userId: string } | { owner: string; name: string }, row: Row): boolean {
        if (scope === 'org') return row.userId === null && row.owner === null;
        if ('userId' in scope) return row.userId === scope.userId;
        return row.owner === scope.owner && row.repoName === scope.name;
    }

    /** The scope columns a row in this scope carries — null for every scope it is not. */
    function scopeColumns(scope: 'org' | { userId: string } | { owner: string; name: string }): {
        userId: string | null;
        owner: string | null;
        repoName: string | null;
    } {
        if (scope === 'org') return { userId: null, owner: null, repoName: null };
        if ('userId' in scope) return { userId: scope.userId, owner: null, repoName: null };
        return { userId: null, owner: scope.owner, repoName: scope.name };
    }

    return store;
}
