import { REPO_FORGES, REPO_PATH_PATTERN, type RepoForge, type RepoRef } from '@factory-ai/core';
import type { Sql, TransactionSql } from 'postgres';

/** A repo-bearing row's identity columns: the forge, the host and the full path. */
export interface RepoRow {
    forge: string;
    host: string;
    repo: string;
}

const isForge = (forge: string): forge is RepoForge => (REPO_FORGES as readonly string[]).includes(forge);

/**
 * The ref a stored row names. A row that is not a well-formed ref throws: reading it as github would match another
 * repository's rows, so the caller's transaction rolls back instead (the same rule as tracked-repos.ts).
 */
export function refOfRow({ forge, host, repo }: RepoRow): RepoRef {
    if (!isForge(forge) || host === '' || !REPO_PATH_PATTERN.test(repo)) {
        throw new Error('a stored row is not a repository reference');
    }
    return { forge, host, path: repo };
}

type Queryable = Sql | TransactionSql;

/** `alias.forge = … and alias.host = … and alias.repo = …`: an exact path match, as `repo = $1` was. */
export const repoIs = (sql: Queryable, alias: string, ref: RepoRef) =>
    sql`${sql(`${alias}.forge`)} = ${ref.forge} and ${sql(`${alias}.host`)} = ${ref.host} and ${sql(`${alias}.repo`)} = ${ref.path}`;

/** A join condition: the two aliases' rows name one repository. */
export const refsMatch = (sql: Queryable, a: string, b: string) =>
    sql`${sql(`${a}.forge`)} = ${sql(`${b}.forge`)} and ${sql(`${a}.host`)} = ${sql(`${b}.host`)} and ${sql(`${a}.repo`)} = ${sql(`${b}.repo`)}`;
