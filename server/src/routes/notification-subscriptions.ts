import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { ERROR_CODES } from '@factory-ai/core';
import { callerOf, orgOf } from '../auth/plugin.js';
import type { ConnectorRegistry } from '../notifications/connector.js';
import { sendTestNotification, TEST_SEND_TIMEOUT_MS } from '../notifications/test-send.js';
import { parseSubscriptionFields } from '../notifications/subscription-fields.js';
import {
    ORG_OWNER,
    type NotificationSubscriptionStore,
    type SubscriptionOwner,
    type SubscriptionView,
} from '../notifications/subscription-store.js';
import type { OrgRegistry } from '../orgs.js';
import { bad, guard } from './helpers.js';

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_CREATED = 201;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_UNAVAILABLE = 503;

const BYTES_PER_KIB = 1024;
const BODY_LIMIT_KIB = 64;
const BODY_LIMIT = BODY_LIMIT_KIB * BYTES_PER_KIB;
const CONTROL_BODY_LIMIT = 4096;

const ORG_PATH = '/api/org/notification-subscriptions';
const PERSONAL_PATH = '/api/workspace/notification-subscriptions';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Gate = { store: NotificationSubscriptionStore; owner: SubscriptionOwner } | null;

/** The two mounts: the org's rows (members read, admins write) or the caller's own (any member, both). */
interface Mount {
    path: string;
    personal: boolean;
    /** The page a test notification links to: where this scope's subscriptions are managed. */
    settingsPath: string;
}

/**
 * Store (503) then caller (401); an org write is an `admin` row the auth hook already gated. Answers the refusal
 * itself and returns null. The owner is the org for the org mount and the caller for the personal one, so a route never names it.
 */
async function gate(
    orgs: OrgRegistry,
    request: FastifyRequest,
    reply: FastifyReply,
    { personal }: { personal: boolean }
): Promise<Gate> {
    const store = (await orgs.for(orgOf(request)))?.notificationSubscriptions;
    if (!store) {
        bad(reply, ERROR_CODES.WORKSPACE_UNAVAILABLE, 'No subscription store for this organization', HTTP_UNAVAILABLE);
        return null;
    }
    const caller = callerOf(request);
    if (!caller) {
        bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
        return null;
    }
    if (personal) return { store, owner: { kind: 'user', userId: caller.user.id } };
    return { store, owner: ORG_OWNER };
}

const log = (request: FastifyRequest) => (e: Error) => request.log.error({ err: e });

const noSuchSubscription = (reply: FastifyReply) =>
    reply.code(HTTP_NOT_FOUND).send({ error: 'No such notification subscription' });

/** An id that cannot be a uuid names no row; asking Postgres would raise 22P02 and read as a 503. */
function idOf(request: FastifyRequest): string | null {
    const { id } = request.params as { id?: string };
    return typeof id === 'string' && UUID.test(id) ? id : null;
}

export const notificationSubscriptionRoutes =
    ({
        orgs,
        connectors,
        publicUrl,
    }: {
        orgs: OrgRegistry;
        connectors: ConnectorRegistry;
        /** The origin a test notification's link points at; null = notifications are off. */
        publicUrl: string | null;
    }): FastifyPluginAsync =>
    async (app) => {
        const register = ({ path, personal, settingsPath }: Mount) => {
            app.get(path, { bodyLimit: CONTROL_BODY_LIMIT }, async (request, reply) => {
                const ctx = await gate(orgs, request, reply, { personal });
                if (!ctx) return reply;
                const loaded = await guard(reply, log(request), () => ctx.store.list(ctx.owner));
                if (!loaded.ok) return reply;
                return reply
                    .code(HTTP_OK)
                    .send({ subscriptions: loaded.value, connectorKinds: [...connectors.keys()] });
            });

            app.post(path, { bodyLimit: BODY_LIMIT }, async (request, reply) => {
                const ctx = await gate(orgs, request, reply, { personal });
                if (!ctx) return reply;
                const parsed = parseSubscriptionFields(request.body, connectors, { credentialRequired: true });
                if (!parsed.ok) return refusal(reply, parsed);
                const { fields, credential } = parsed;
                const saved = await guard(reply, log(request), () =>
                    ctx.store.create(ctx.owner, fields, credential as string)
                );
                if (!saved.ok) return reply;
                return reply.code(HTTP_CREATED).send(saved.value);
            });

            app.put(`${path}/:id`, { bodyLimit: BODY_LIMIT }, async (request, reply) => {
                const ctx = await gate(orgs, request, reply, { personal });
                if (!ctx) return reply;
                return replace(ctx, connectors, request, reply);
            });

            app.delete(`${path}/:id`, { bodyLimit: CONTROL_BODY_LIMIT }, async (request, reply) => {
                const ctx = await gate(orgs, request, reply, { personal });
                if (!ctx) return reply;
                return remove(ctx, request, reply);
            });

            app.post(`${path}/:id/test`, { bodyLimit: CONTROL_BODY_LIMIT }, async (request, reply) => {
                const ctx = await gate(orgs, request, reply, { personal });
                if (!ctx) return reply;
                return testSend(ctx, { connectors, publicUrl, settingsPath }, request, reply);
            });
        };
        register({ path: ORG_PATH, personal: false, settingsPath: '/settings/organization' });
        register({ path: PERSONAL_PATH, personal: true, settingsPath: '/settings/workspace' });
    };

async function replace(
    ctx: NonNullable<Gate>,
    connectors: ConnectorRegistry,
    request: FastifyRequest,
    reply: FastifyReply
) {
    const id = idOf(request);
    if (!id) return noSuchSubscription(reply);
    const parsed = parseSubscriptionFields(request.body, connectors, { credentialRequired: false });
    if (!parsed.ok) return refusal(reply, parsed);
    const { fields, credential } = parsed;
    const saved = await guard(reply, log(request), () => ctx.store.update(ctx.owner, id, fields, credential));
    if (!saved.ok) return reply;
    return replaced(reply, saved.value);
}

async function remove(ctx: NonNullable<Gate>, request: FastifyRequest, reply: FastifyReply) {
    const id = idOf(request);
    if (!id) return noSuchSubscription(reply);
    const removed = await guard(reply, log(request), () => ctx.store.remove(ctx.owner, id));
    if (!removed.ok) return reply;
    if (!removed.value) return noSuchSubscription(reply);
    return reply.code(HTTP_OK).send({ id, removed: true });
}

/** A PUT's outcome: the row, a missing row, or a kind change that needs a new credential. */
function replaced(reply: FastifyReply, value: SubscriptionView | null | 'kind-changed') {
    if (value === 'kind-changed') {
        return bad(reply, ERROR_CODES.BAD_BODY, 'credential required when connectorKind changes');
    }
    if (!value) return noSuchSubscription(reply);
    return reply.code(HTTP_OK).send(value);
}

function refusal(reply: FastifyReply, parsed: { code: string; message: string; problems?: string[] }) {
    if (!parsed.problems) return bad(reply, parsed.code, parsed.message);
    return reply.code(HTTP_BAD_REQUEST).send({ error: parsed.message, code: parsed.code, problems: parsed.problems });
}

/** 200 `{ result }` for every connector verdict; 404 only for a confirmed missing row; 503 for PUBLIC_URL unset or a failed read. */
async function testSend(
    ctx: NonNullable<Gate>,
    {
        connectors,
        publicUrl,
        settingsPath,
    }: { connectors: ConnectorRegistry; publicUrl: string | null; settingsPath: string },
    request: FastifyRequest,
    reply: FastifyReply
) {
    const id = idOf(request);
    if (!id) return noSuchSubscription(reply);
    if (publicUrl === null) {
        return bad(reply, ERROR_CODES.UNAVAILABLE, 'PUBLIC_URL is unset: notifications are off', HTTP_UNAVAILABLE);
    }
    const sent = await guard(reply, log(request), () =>
        sendTestNotification({
            connectors,
            readTarget: (signal) => ctx.store.testTarget(ctx.owner, id, signal),
            orgId: orgOf(request),
            publicUrl,
            settingsPath,
            signal: AbortSignal.timeout(TEST_SEND_TIMEOUT_MS),
        })
    );
    if (!sent.ok) return reply;
    if (sent.value === null) return noSuchSubscription(reply);
    return reply.code(HTTP_OK).send({ result: sent.value });
}
