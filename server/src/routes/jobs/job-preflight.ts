import {
    ERROR_CODES,
    executorMissingMessage,
    executorSuspendedMessage,
    NO_MODEL_MESSAGE,
    requiredProviders,
    noExecutorMessage,
    selectedBy,
    type ExecutorScope,
} from '@factory-ai/core';
import type { FastifyBaseLogger, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { callerOf, orgOf } from '../../auth/plugin.js';
import { BINDABLE_PROVIDERS, type Resolution, type ResolveRefusal } from '../../db/connection-bindings.js';
import type { ConnectionView } from '../../db/connection-store.js';
import { ConfiguredDefaultUnusableError, type UserExecutorStore } from '../../db/user-executor-store.js';
import type { OrgRegistry } from '../../orgs.js';
import {
    abortOnClose,
    effectiveCatalog,
    standingOf,
    type EffectiveCatalog,
    type ExecutorTypeRead,
} from '../../skill-catalog.js';
import {
    executorTypeOf,
    modelStanding,
    type SelectedProfileConnection,
    selectedConnectionOf,
} from './executor-usable.js';
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
    subject: 'repo' | 'executor' | 'model' | 'skill' | 'connection';
    name: string | null;
    status: Status;
    /** The refusal code create would answer for this blocked check (`NO_MODEL`); absent on the others. */
    code?: string;
    detail: string;
    /** Set on a blocked check that only a connection of the caller's own can clear: which provider and why. */
    integration?: { provider: string; reason: IntegrationReason };
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
    baseBranch: string | null;
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
        baseBranch: branch.value,
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

/** The executor check and the executor type it resolved, which says which checkout directories hold the repo's skills. */
interface ExecutorStanding {
    check: Check;
    type: ExecutorTypeRead;
    /** The resolved profile's config, which may hold the model credential; absent when no profile resolved. */
    config?: Record<string, unknown>;
    /** The provider connection the resolved profile selects; absent when it selects none. */
    connection?: SelectedProfileConnection | null;
}

/** `resolvedDefault`, answering a configured default that cannot run as itself: a verdict, as create refuses it, not an unreadable default. */
async function defaultOrRefusal(store: Pick<UserExecutorStore, 'resolvedDefault'>, userId: string) {
    try {
        return await store.resolvedDefault(userId);
    } catch (error) {
        if (error instanceof ConfiguredDefaultUnusableError) return error;
        throw error;
    }
}

/**
 * What a task naming no executor resolves to: the profile create will stamp, or the standing that already answers (no
 * default, a configured default that cannot run, an unreadable default). Create stamps the caller's
 * resolved default (executor-usable.ts), so that is the verdict.
 */
async function defaultStanding(
    log: FastifyBaseLogger,
    store: Pick<UserExecutorStore, 'resolvedDefault'>,
    userId: string
): Promise<ExecutorStanding | { name: string; scope: ExecutorScope }> {
    const fallback = await attempt(log, 'default executor', () => defaultOrRefusal(store, userId));
    if (!fallback.ok) {
        return {
            check: {
                subject: 'executor',
                name: null,
                status: 'unverified',
                detail: 'the default executor could not be read',
            },
            type: { state: 'unconfirmed', error: 'the default executor could not be read' },
        };
    }
    if (fallback.value instanceof ConfiguredDefaultUnusableError) {
        const detail = fallback.value.message;
        return {
            check: { subject: 'executor', name: fallback.value.executorName, status: 'blocked', detail },
            type: { state: 'unconfirmed', error: detail },
        };
    }
    if (fallback.value === null) {
        return {
            check: { subject: 'executor', name: null, status: 'blocked', detail: noExecutorMessage },
            type: { state: 'unconfirmed', error: noExecutorMessage },
        };
    }
    return { name: fallback.value.name, scope: fallback.value.scope };
}

async function executorCheck(
    log: FastifyBaseLogger,
    selection: Selection,
    userId: string,
    rt: Runtime
): Promise<ExecutorStanding> {
    const { executor, scope } = selection;
    const store = rt.userExecutors;
    if (!store) {
        return {
            check: {
                subject: 'executor',
                name: executor,
                status: 'unverified',
                detail: 'executor profiles cannot be read on this board',
            },
            // Create resolves nothing without a store, and the task runs claude.
            type: { state: 'known', type: null },
        };
    }
    let name = executor;
    let at = scope;
    if (name === null) {
        const resolved = await defaultStanding(log, store, userId);
        if ('check' in resolved) return resolved;
        ({ name, scope: at } = resolved);
    }
    const row = await attempt(log, 'executor profile', () => store.configFor(userId, name, at));
    if (!row.ok) {
        const detail = 'the executor profiles could not be read';
        return {
            check: { subject: 'executor', name, status: 'unverified', detail },
            type: { state: 'unconfirmed', error: detail },
        };
    }
    if (row.value === null) {
        const detail = executorMissingMessage(at, name);
        return {
            check: { subject: 'executor', name, status: 'blocked', detail },
            type: { state: 'unconfirmed', error: detail },
        };
    }
    if (row.value.suspended) {
        const detail = executorSuspendedMessage(at, name);
        return {
            check: { subject: 'executor', name, status: 'blocked', detail },
            type: { state: 'unconfirmed', error: detail },
        };
    }
    const detail =
        executor === null ? `none selected: the task runs on your default, ${at} ${name}` : `${at} ${row.value.type}`;
    return {
        check: { subject: 'executor', name, status: 'ok', detail },
        type: executorTypeOf(row.value.type),
        config: row.value.config,
        connection: selectedConnectionOf(row.value.providerConnectionId, at),
    };
}

/**
 * Where the board requires one (cloud), whether the task's agent has a model credential, by create's
 * predicate (`modelStanding`): blocked with the fix when it has none; unverified when the agent is not resolved or the
 * env cannot be read. Null where no credential is required.
 */
async function modelCheck(
    log: FastifyBaseLogger,
    selection: Selection,
    userId: string,
    { rt, executor }: { rt: Runtime; executor: ExecutorStanding }
): Promise<Check | null> {
    if (!rt.modelRequired && !executor.connection) return null;
    const subject = {
        userId,
        repo: selection.repo,
        type: executor.type,
        config: executor.config ?? null,
        connection: executor.connection ?? null,
    };
    const read = await attempt(log, 'model credential names', () => modelStanding(rt, subject));
    if (!read.ok || read.value === 'unverified') {
        return {
            subject: 'model',
            name: null,
            status: 'unverified',
            detail: 'the model credential could not be checked',
        };
    }
    // A selected connection the shared rules refuse blocks whether the board requires a key or not: the claim refuses it too.
    if (typeof read.value === 'object') {
        return {
            subject: 'model',
            name: null,
            status: 'blocked',
            code: ERROR_CODES.PROVIDER_CONNECTION_REFUSED,
            detail: read.value.refused.message,
        };
    }
    if (read.value === 'not-required') {
        return {
            subject: 'model',
            name: null,
            status: 'ok',
            detail: 'the selected provider connection can run this executor',
        };
    }
    if (read.value === 'missing') {
        return {
            subject: 'model',
            name: null,
            status: 'blocked',
            code: ERROR_CODES.NO_MODEL,
            detail: NO_MODEL_MESSAGE,
        };
    }
    return { subject: 'model', name: null, status: 'ok', detail: 'a model credential is set' };
}

/** `unknown`: the caller's connection list could not be read, so `missing` would be a guess. */
type IntegrationReason = 'missing' | 'ambiguous' | 'reconnect' | 'unknown';

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
    if (found?.needsReconnect) {
        return {
            subject: 'connection',
            name: id,
            status: 'blocked',
            detail: 'its grant is no longer active: reconnect it',
            integration: { provider: found.provider, reason: 'reconnect' },
        };
    }
    return { subject: 'connection', name: id, status: 'blocked', detail: 'no such connection available to you' };
}

/** Each named connection, then the resolver's verdict on what the selected skills still need. */
async function connectionStanding(
    log: FastifyBaseLogger,
    selection: Selection,
    caller: { userId: string; rt: Runtime },
    catalog: EffectiveCatalog
): Promise<Standing> {
    const { userId, rt } = caller;
    const required = requiredProviders(catalog.entries, selection.skills);
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

function skillChecks(selection: Selection, standing: Standing, catalog: EffectiveCatalog): Check[] {
    return selection.skills.flatMap((name): Check[] => {
        const skill = catalog.entries.find((candidate) => candidate.name === name);
        if (!skill || standingOf(catalog, name) === 'unverified') {
            return standingOf(catalog, name) === 'unverified'
                ? [
                      {
                          subject: 'skill',
                          name,
                          status: 'unverified',
                          detail: "the repository's skills could not be read; the board checks them at create",
                      },
                  ]
                : [
                      {
                          subject: 'skill',
                          name,
                          status: 'blocked',
                          detail: 'not installed on this board or in the repository',
                      },
                  ];
        }
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
            if (open) {
                const reason = openReason(provider, open.reason, standing);
                return {
                    subject: 'skill',
                    name,
                    status: 'blocked',
                    detail: openDetail(provider, reason),
                    integration: { provider, reason },
                };
            }
            const bound = standing.resolution.bindings.find((binding) => binding.provider === provider);
            return {
                subject: 'skill',
                name,
                status: 'ok',
                detail: bound ? `${provider} connection selected (${bound.source})` : `${provider} connection selected`,
            };
        });
        return needs.length > 0
            ? needs
            : [
                  {
                      subject: 'skill',
                      name,
                      status: 'ok',
                      detail: skill.source === 'repo' ? 'in the repository' : 'installed',
                  },
              ];
    });
}

/** A lapsed grant of the provider outranks `missing`: the member has a connection, it needs reconnecting. */
function openReason(provider: string, reason: 'missing' | 'ambiguous', standing: Standing): IntegrationReason {
    if (reason === 'ambiguous') return reason;
    if (!standing.listed) return 'unknown';
    return standing.listed.some((c) => c.provider === provider && c.needsReconnect) ? 'reconnect' : reason;
}

function openDetail(provider: string, reason: IntegrationReason): string {
    if (reason === 'unknown')
        return `no usable ${provider} connection was found, and your connections could not be listed`;
    if (reason === 'ambiguous')
        return `several ${provider} connections could serve: pass connections with the one to use`;
    if (reason === 'reconnect') return `your ${provider} connection's grant is no longer active: reconnect it`;
    return `no ${provider} connection of yours: connect one, then pass connections`;
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
    const executor = await executorCheck(log, selection, userId, rt);
    const catalog = await effectiveCatalog({
        builtin: skillCatalog(),
        read: rt.repoSkills,
        repo: selection.repo,
        branch: selection.baseBranch,
        executorType: executor.type,
        signal: abortOnClose(reply),
        need: selection.skills,
        stored: { store: rt.skills, userId },
        onUnconfirmed: (err) => log.warn({ err }, 'preflight: repo skills could not be read'),
    });
    const standing = await connectionStanding(log, selection, { userId, rt }, catalog);
    const model = await modelCheck(log, selection, userId, { rt, executor });
    const checks = [
        await repoCheck(log, selection.repo, rt),
        executor.check,
        ...(model ? [model] : []),
        ...skillChecks(selection, standing, catalog),
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
