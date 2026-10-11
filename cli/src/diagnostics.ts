import type { ConnectionView, SkillView, WorkspaceView } from './board.js';
import type { CliConfig } from './config.js';

/**
 * What `auth status` and `job preflight` report, joined from the board's own reads. Pure: nothing
 * here calls the board, and those commands only issue GETs. Preflight is advisory — the board
 * rechecks every rule at create and at claim, and its refusal is the answer.
 */

/** The effective configuration with the credential reduced to whether it is set, and of which kind. */
export interface ConfigSummary {
    url: string;
    /** Never a character of the token: `kind` is read from its public prefix, for display only. */
    token: { set: boolean; kind: 'personal' | 'org' | 'unrecognized' | null };
    requestTimeoutSeconds: number;
    readRetries: number;
}

const MS_PER_SECOND = 1000;

function tokenKind(token: string): ConfigSummary['token']['kind'] {
    if (!token) return null;
    if (token.startsWith('fat_')) return 'personal';
    if (token.startsWith('oat_')) return 'org';
    return 'unrecognized';
}

export function configSummary(config: CliConfig): ConfigSummary {
    return {
        url: config.url,
        token: { set: config.token !== '', kind: tokenKind(config.token) },
        requestTimeoutSeconds: config.requestTimeoutMs / MS_PER_SECOND,
        readRetries: config.readRetries,
    };
}

export interface PreflightSelection {
    repo?: string | undefined;
    executor?: string | undefined;
    executorScope?: 'user' | 'org' | undefined;
    skills?: string[] | undefined;
    jiraConnection?: string | undefined;
}

export interface PreflightCheck {
    subject: 'repo' | 'executor' | 'skill' | 'connection';
    name: string | null;
    /** `unverified`: only the board can say, and it does at claim. */
    status: 'ok' | 'blocked' | 'unverified';
    detail: string;
}

export interface Preflight {
    ready: boolean;
    checks: PreflightCheck[];
}

/** The board's selector for a managed Jira connection on a skill requirement (`GET /api/skills`). */
const JIRA_SELECTOR = 'jiraConnection';

function repoCheck(repo: string | undefined, workspace: WorkspaceView): PreflightCheck {
    const name = repo ?? null;
    if (workspace.root === null) {
        return { subject: 'repo', name, status: 'unverified', detail: 'workspaces are off on this board' };
    }
    if (repo === undefined) {
        return {
            subject: 'repo',
            name,
            status: 'blocked',
            detail: 'pass --repo: a task runs against a synced repository',
        };
    }
    const row = workspace.repos.find((candidate) => `${candidate.owner}/${candidate.name}` === repo);
    if (!row)
        return { subject: 'repo', name, status: 'blocked', detail: `${repo} is not in your selected repositories` };
    if (row.status !== 'ready') {
        const error = row.error ? `: ${row.error}` : '';
        return { subject: 'repo', name, status: 'blocked', detail: `${repo} is ${row.status}, not synced yet${error}` };
    }
    return { subject: 'repo', name, status: 'ok', detail: 'synced and ready' };
}

function executorCheck(selection: PreflightSelection, workspace: WorkspaceView): PreflightCheck {
    const { executor } = selection;
    if (executor === undefined) {
        // The board applies no default at create; `defaultExecutor` is only the web composer's preselection.
        const fallback = workspace.defaultExecutor;
        const hint = fallback ? ` (your default is ${fallback.scope} ${fallback.name})` : '';
        return {
            subject: 'executor',
            name: null,
            status: 'blocked',
            detail: `no executor selected: pass --executor${hint}`,
        };
    }
    const scope = selection.executorScope ?? 'user';
    const profiles = scope === 'org' ? workspace.orgExecutors : workspace.executors;
    const profile = profiles.find((candidate) => candidate.name === executor);
    if (!profile) {
        return { subject: 'executor', name: executor, status: 'blocked', detail: `no ${scope} executor ${executor}` };
    }
    if (profile.suspended === true) {
        return { subject: 'executor', name: executor, status: 'blocked', detail: `${scope} executor is suspended` };
    }
    return { subject: 'executor', name: executor, status: 'ok', detail: `${scope} ${profile.type}` };
}

function skillChecks(selection: PreflightSelection, skills: readonly SkillView[]): PreflightCheck[] {
    return (selection.skills ?? []).flatMap((name): PreflightCheck[] => {
        const skill = skills.find((candidate) => candidate.name === name);
        if (!skill) return [{ subject: 'skill', name, status: 'blocked', detail: 'not installed on this board' }];
        const needs = skill.requires.connections.map((connection): PreflightCheck => {
            if (connection.selectedBy === JIRA_SELECTOR && selection.jiraConnection === undefined) {
                return {
                    subject: 'skill',
                    name,
                    status: 'blocked',
                    detail: `needs a ${connection.name} connection: pass --jira-connection`,
                };
            }
            if (connection.selectedBy === null) {
                return {
                    subject: 'skill',
                    name,
                    status: 'unverified',
                    detail: `needs the ${connection.name} connection; the board checks it at claim`,
                };
            }
            return { subject: 'skill', name, status: 'ok', detail: `${connection.name} connection selected` };
        });
        return needs.length > 0 ? needs : [{ subject: 'skill', name, status: 'ok', detail: 'installed' }];
    });
}

function connectionCheck(id: string, connections: readonly ConnectionView[]): PreflightCheck {
    const found = connections.find((connection) => connection.id === id && connection.kind === 'jira');
    return found
        ? { subject: 'connection', name: id, status: 'ok', detail: `${found.scope} ${found.site}` }
        : { subject: 'connection', name: id, status: 'blocked', detail: 'no such Jira connection available to you' };
}

export function preflightChecks(
    selection: PreflightSelection,
    reads: { workspace: WorkspaceView; skills: readonly SkillView[]; connections: readonly ConnectionView[] }
): Preflight {
    const checks = [
        repoCheck(selection.repo, reads.workspace),
        executorCheck(selection, reads.workspace),
        ...skillChecks(selection, reads.skills),
        ...(selection.jiraConnection === undefined
            ? []
            : [connectionCheck(selection.jiraConnection, reads.connections)]),
    ];
    return { ready: checks.every((check) => check.status !== 'blocked'), checks };
}
