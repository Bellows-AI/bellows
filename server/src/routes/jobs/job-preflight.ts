import {
    ERROR_CODES,
    executorMissingMessage,
    executorSuspendedMessage,
    requiredProviders,
    selectedBy,
    type ExecutorScope,
} from '@factory-ai/core';
import type { FastifyBaseLogger, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { callerOf, orgOf } from '../../auth/plugin.js';
import { BINDABLE_PROVIDERS, type Resolution, type ResolveRefusal } from '../../db/connection-bindings.js';
import type { ConnectionView } from '../../db/connection-store.js';
import type { OrgRegistry } from '../../orgs.js';
import { skillCatalog } from '../../skills.js';
import { bad, body } from '../helpers.js';
import { parseConnectionIds } from '../connections.js';
import { CONTROL_BODY_LIMIT, HTTP_OK, noBoard } from './job-limits.js';
import {
    validateBaseBranchField,
    validateExecutorField,
    validateExecutorScopeField,
    validateRepoField,
    validateSkillsField,
} from './job-field-validation.js';

/**
 * `POST /api/jobs/preflight`: the advisory checks of a create's selection, made from the board's own stores.
 * It answers what `POST /api/jobs` would decide, by the same predicates (`executor-usable.ts`,
 * `ConnectionStore.preview` over `resolveBindingsInTx`), and writes nothing. A read that fails or comes back
 * unconfirmed makes the checks it feeds `unverified`, never `ok` or `blocked`; the board rechecks at create
 * and at claim.
 */

const HTTP_UNAUTHORIZED = 401;

type Status = 'ok' | 'blocked' | 'unverified';

interface Check {
    subject: 'repo' | 'executor' | 'skill' | 'connection';
    name: string | null;
    status: Status;
    detail: string;
}

type Read<T> = { ok: true; value: T } | { ok: false };

const FIELDS = ['repo', 'baseBranch', 'executor', 'executorScope', 'skills', 'connections'];

async function attempt<T>(log: FastifyBaseLogger, what: string, read: () => Promise<T>): Promise<Read<T>> {
    try {
        return { ok: true, value: await read() };
    } catch (error) {
        log.warn({ err: error }, `preflight: ${what} could not be read`);
        return { ok: false };
    }
}

interface Selection {
    repo: string | null;
    executor: string | null;
    scope: ExecutorScope;
    skills: string[];
    connections: string[];
}

/** The body as a selection, or the 400 already sent. */
function selectionOf(reply: FastifyReply, raw: unknown): Selection | null {
    const refuse = (code: string, message: string): null => {
        bad(reply, code, message);
        return null;
    };
    const fields = body(raw);
    const unknown = Object.keys(fields).find((key) => !FIELDS.includes(key));
    if (unknown) return refuse(ERROR_CODES.BAD_BODY, `unknown field "${unknown}"`);
    const repo = validateRepoField(fields.repo);
    if (!repo.ok) return refuse(ERROR_CODES.BAD_REPO, repo.message);
    const branch = validateBaseBranchField(fields.baseBranch);
    if (!branch.ok) return refuse(ERROR_CODES.BAD_BASE_BRANCH, branch.message);
    const executor = validateExecutorField(fields.executor);
    if (!executor.ok) return refuse(ERROR_CODES.BAD_EXECUTOR, executor.message);
    const scope = validateExecutorScopeField(fields.executorScope);
    if (!scope.ok) return refuse(ERROR_CODES.BAD_EXECUTOR_SCOPE, scope.message);
    const skills = validateSkillsField(fields.skills);
    if (!skills.ok) return refuse(ERROR_CODES.BAD_SKILLS, skills.message);
    const connections = parseConnectionIds(fields.connections);
    if (typeof connections === 'string') return refuse(ERROR_CODES.BAD_CONNECTION, connections);
    return {
        repo: repo.value,
        executor: executor.value,
        scope: scope.value,
        skills: skills.value,
        connections,
    };
}

type Runtime = NonNullable<Awaited<ReturnType<OrgRegistry['for']>>>;

async function repoCheck(log: FastifyBaseLogger, repo: string | null, rt: Runtime): Promise<Check> {
    if (repo === null) {
        return {
            subject: 'repo',
            name: null,
            status: 'blocked',
            detail: 'pass repo: a task runs against a tracked repository',
        };
    }
    const unread = { subject: 'repo', name: repo, status: 'unverified' } as const;
    const read = await attempt(log, 'tracked repositories', () => rt.repos.detail());
    if (!read.ok) return { ...unread, detail: 'the tracked repositories could not be read' };
    // A list that came with a refresh error is stale: neither membership nor absence in it is a verdict.
    if (read.value.error !== null) {
        return { ...unread, detail: `the tracked list may be stale: ${read.value.error}` };
    }
    if (read.value.repos.some((candidate) => `${candidate.owner}/${candidate.name}` === repo)) {
        return { subject: 'repo', name: repo, status: 'ok', detail: 'tracked by this board' };
    }
    return { subject: 'repo', name: repo, status: 'blocked', detail: `${repo} is not tracked by this board` };
}

async function executorCheck(
    log: FastifyBaseLogger,
    selection: Selection,
    userId: string,
    rt: Runtime
): Promise<Check> {
    const { executor, scope } = selection;
    const store = rt.userExecutors;
    if (!store) {
        return {
            subject: 'executor',
            name: executor,
            status: 'unverified',
            detail: 'executor profiles cannot be read on this board',
        };
    }
    if (executor === null) {
        // The board applies no default at create; the default is only the web composer's preselection.
        const fallback = await attempt(log, 'default executor', () => store.resolvedDefault(userId));
        const hint =
            fallback.ok && fallback.value ? ` (your default is ${fallback.value.scope} ${fallback.value.name})` : '';
        return {
            subject: 'executor',
            name: null,
            status: 'blocked',
            detail: `no executor selected: pass executor${hint}`,
        };
    }
    const row = await attempt(log, 'executor profile', () => store.configFor(userId, executor, scope));
    if (!row.ok) {
        return {
            subject: 'executor',
            name: executor,
            status: 'unverified',
            detail: 'the executor profiles could not be read',
        };
    }
    if (row.value === null) {
        return {
            subject: 'executor',
            name: executor,
            status: 'blocked',
            detail: executorMissingMessage(scope, executor),
        };
    }
    if (row.value.suspended) {
        return {
            subject: 'executor',
            name: executor,
            status: 'blocked',
            detail: executorSuspendedMessage(scope, executor),
        };
    }
    return { subject: 'executor', name: executor, status: 'ok', detail: `${scope} ${row.value.type}` };
}

/** What the caller's connections answered: the explicit ids that passed, the display list, and the resolution. */
interface Standing {
    checks: Check[];
    /** Null when the resolver could not be read: every skill that needs a connection is then unverified. */
    resolution: Resolution | null;
    listed: ConnectionView[] | null;
}

const UNVERIFIED_CONNECTIONS = 'the connections could not be read; the board checks them at create';

/** One named connection's verdict; `resolved` is null when the resolver could not be read. */
function explicitCheck(
    id: string,
    resolved: Resolution | ResolveRefusal | null,
    listed: ConnectionView[] | null
): Check {
    const found = listed?.find((connection) => connection.id === id);
    if (resolved === null)
        return { subject: 'connection', name: id, status: 'unverified', detail: UNVERIFIED_CONNECTIONS };
    if (resolved.ok) {
        const detail = found ? `${found.ownership} ${found.site}` : 'available to you';
        return { subject: 'connection', name: id, status: 'ok', detail };
    }
    // Another member's, another org's and absent are one answer: nothing more is said about it.
    const detail = found?.needsReconnect
        ? 'its grant is no longer active: reconnect it'
        : 'no such connection available to you';
    return { subject: 'connection', name: id, status: 'blocked', detail };
}

/** Each named connection, then the resolver's verdict on what the selected skills still need. */
async function connectionStanding(
    log: FastifyBaseLogger,
    selection: Selection,
    userId: string,
    rt: Runtime
): Promise<Standing> {
    const required = requiredProviders(skillCatalog(), selection.skills);
    const store = rt.connections;
    if (!store) {
        const checks = selection.connections.map(
            (id): Check => ({ subject: 'connection', name: id, status: 'unverified', detail: UNVERIFIED_CONNECTIONS })
        );
        return { checks, resolution: null, listed: null };
    }
    const listRead = await attempt(log, 'connections', () => store.list(userId));
    const listed = listRead.ok ? listRead.value : null;
    const usable: string[] = [];
    let unconfirmed = false;
    const checks: Check[] = [];
    for (const id of selection.connections) {
        const one = await attempt(log, 'connection', () =>
            store.preview({ executionUser: userId, explicit: [id], providers: [], required: [] })
        );
        checks.push(explicitCheck(id, one.ok ? one.value : null, listed));
        if (!one.ok) unconfirmed = true;
        else if (one.value.ok) usable.push(id);
    }
    if (required.length === 0) return { checks, resolution: { ok: true, bindings: [], requirements: [] }, listed };
    // An explicit selection that could not be read may be the one that decides the defaults: no verdict without it.
    if (unconfirmed) return { checks, resolution: null, listed };
    const resolved = await attempt(log, 'default connections', () =>
        store.preview({ executionUser: userId, explicit: usable, providers: [...BINDABLE_PROVIDERS], required })
    );
    return { checks, resolution: resolved.ok && resolved.value.ok ? resolved.value : null, listed };
}

function skillChecks(selection: Selection, standing: Standing): Check[] {
    const catalog = skillCatalog();
    return selection.skills.flatMap((name): Check[] => {
        const skill = catalog.find((candidate) => candidate.name === name);
        if (!skill) return [{ subject: 'skill', name, status: 'blocked', detail: 'not installed on this board' }];
        const needs = skill.requires.connections.map((provider): Check => {
            if (selectedBy(provider) === null) {
                return {
                    subject: 'skill',
                    name,
                    status: 'unverified',
                    detail: `needs the ${provider} connection; the board checks it at claim`,
                };
            }
            if (standing.resolution === null) {
                return {
                    subject: 'skill',
                    name,
                    status: 'unverified',
                    detail: `${provider}: ${UNVERIFIED_CONNECTIONS}`,
                };
            }
            const open = standing.resolution.requirements.find((requirement) => requirement.provider === provider);
            if (open)
                return {
                    subject: 'skill',
                    name,
                    status: 'blocked',
                    detail: openDetail(provider, open.reason, standing),
                };
            const bound = standing.resolution.bindings.find((binding) => binding.provider === provider);
            return {
                subject: 'skill',
                name,
                status: 'ok',
                detail: bound ? `${provider} connection selected (${bound.source})` : `${provider} connection selected`,
            };
        });
        return needs.length > 0 ? needs : [{ subject: 'skill', name, status: 'ok', detail: 'installed' }];
    });
}

function openDetail(provider: string, reason: 'missing' | 'ambiguous', standing: Standing): string {
    if (reason === 'ambiguous') {
        return `several ${provider} connections could serve: pass connections with the one to use`;
    }
    const lapsed = standing.listed?.some((c) => c.provider === provider && c.needsReconnect) ?? false;
    return lapsed
        ? `your ${provider} connection's grant is no longer active: reconnect it`
        : `no ${provider} connection of yours: connect one, then pass connections`;
}

async function handlePreflight(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const caller = callerOf(request);
    if (!caller) return bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
    const rt = await orgs.for(orgOf(request));
    if (!rt) return noBoard(reply);
    const selection = selectionOf(reply, request.body);
    if (!selection) return reply;
    const userId = caller.user.id;
    const { log } = request;
    const standing = await connectionStanding(log, selection, userId, rt);
    const checks = [
        await repoCheck(log, selection.repo, rt),
        await executorCheck(log, selection, userId, rt),
        ...skillChecks(selection, standing),
        ...standing.checks,
    ];
    return reply.code(HTTP_OK).send({ ready: checks.every((check) => check.status !== 'blocked'), checks });
}

/**
 * Advisory and read-only: what a create of this selection would decide, answered without queueing it. Its own
 * plugin beside `jobRoutes`; the static segment wins over `/api/jobs/:id`, and no `POST /api/jobs/:id` exists.
 */
export const preflightRoutes =
    (orgs: OrgRegistry): FastifyPluginAsync =>
    async (app) => {
        app.post('/api/jobs/preflight', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handlePreflight(orgs, request, reply)
        );
    };
