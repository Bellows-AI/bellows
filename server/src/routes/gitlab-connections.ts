import { ERROR_CODES, HOST_PATTERN } from '@factory-ai/core';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { orgOf } from '../auth/plugin.js';
import type { ForgeConnectionStore } from '../db/forge-connections.js';
import type { OrgRegistry } from '../orgs.js';
import { bad, body, guard } from './helpers.js';

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_CREATED = 201;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_UNAVAILABLE = 503;

const BYTES_PER_KIB = 1024;
const BODY_LIMIT_KIB = 128;
const CA_BUNDLE_KIB = 64;
const BODY_LIMIT = BODY_LIMIT_KIB * BYTES_PER_KIB;
const CONTROL_BODY_KIB = 4;
const CONTROL_BODY_LIMIT = CONTROL_BODY_KIB * BYTES_PER_KIB;
const PATH = '/api/org/gitlab-connections';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GROUP = /^[A-Za-z0-9._-]+$/;
const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/;
const HOST_LIMIT = 255;
const FIELD_LIMIT = 512;
const SECRET_LIMIT = 4096;
const GROUP_LIMIT = 100;
const CA_BUNDLE_LIMIT = CA_BUNDLE_KIB * BYTES_PER_KIB;

type Parsed = { ok: true; input: Parameters<ForgeConnectionStore['create']>[0] } | { ok: false; message: string };

const text = (value: unknown, limit: number): string | null =>
    typeof value === 'string' && value.trim() !== '' && value.length <= limit ? value : null;

/** The connection a body asks for, or the first thing wrong with it. The host is a bare `host[:port]`, never a URL. */
function parse(raw: unknown): Parsed {
    const fields = body(raw);
    const host = text(fields.host, HOST_LIMIT);
    if (host === null || !HOST_PATTERN.test(host))
        return { ok: false, message: 'host must be a bare host name with an optional port' };
    const clientId = text(fields.clientId, FIELD_LIMIT);
    if (clientId === null || /\s/.test(clientId)) return { ok: false, message: 'clientId is required' };
    const clientSecret = text(fields.clientSecret, SECRET_LIMIT);
    if (clientSecret === null) return { ok: false, message: 'clientSecret is required' };
    const groups = fields.allowedGroups;
    if (
        !Array.isArray(groups) ||
        groups.length === 0 ||
        groups.length > GROUP_LIMIT ||
        !groups.every((group) => typeof group === 'string' && GROUP.test(group))
    ) {
        return { ok: false, message: 'allowedGroups must list one or more root group paths' };
    }
    const { caBundle } = fields;
    if (
        caBundle !== undefined &&
        (typeof caBundle !== 'string' || caBundle.length > CA_BUNDLE_LIMIT || !PEM_CERTIFICATE.test(caBundle))
    ) {
        return { ok: false, message: 'caBundle must be PEM certificates' };
    }
    return {
        ok: true,
        input: {
            host: host.toLowerCase(),
            clientId,
            clientSecret,
            allowedGroups: [...new Set(groups as string[])],
            ...(caBundle === undefined ? {} : { caBundle: caBundle as string }),
        },
    };
}

/** The org's connection store (503 when it has none); the admin role is the route class's (`auth/route-class.ts`). */
async function storeOf(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const store = (await orgs.for(orgOf(request)))?.forgeConnections;
    if (!store) {
        bad(reply, ERROR_CODES.WORKSPACE_UNAVAILABLE, 'No connection store for this organization', HTTP_UNAVAILABLE);
        return null;
    }
    return store;
}

const log = (request: FastifyRequest) => (e: Error) => request.log.error({ err: e });

/** An id that cannot be a uuid names no row; asking Postgres would raise 22P02 and read as a 503. */
const idOf = (request: FastifyRequest): string | null => {
    const { id } = request.params as { id?: string };
    return typeof id === 'string' && UUID.test(id) ? id : null;
};

const noSuchConnection = (reply: FastifyReply) =>
    reply.code(HTTP_NOT_FOUND).send({ error: 'No such GitLab connection' });

/** The organization's GitLab connections: admin-only, the stored pending state and never a secret (docs/connections.md). */
export const gitlabConnectionRoutes =
    ({ orgs }: { orgs: OrgRegistry }): FastifyPluginAsync =>
    async (app) => {
        app.get(PATH, { bodyLimit: CONTROL_BODY_LIMIT }, async (request, reply) => {
            const store = await storeOf(orgs, request, reply);
            if (!store) return reply;
            const loaded = await guard(reply, log(request), () => store.list());
            if (!loaded.ok) return reply;
            return reply.code(HTTP_OK).send({ connections: loaded.value });
        });

        app.get(`${PATH}/:id`, { bodyLimit: CONTROL_BODY_LIMIT }, async (request, reply) => {
            const store = await storeOf(orgs, request, reply);
            if (!store) return reply;
            const id = idOf(request);
            if (!id) return noSuchConnection(reply);
            const loaded = await guard(reply, log(request), () => store.get(id));
            if (!loaded.ok) return reply;
            return loaded.value ? reply.code(HTTP_OK).send(loaded.value) : noSuchConnection(reply);
        });

        app.post(PATH, { bodyLimit: BODY_LIMIT }, async (request, reply) => {
            const store = await storeOf(orgs, request, reply);
            if (!store) return reply;
            const parsed = parse(request.body);
            if (!parsed.ok) return bad(reply, ERROR_CODES.INVALID_GITLAB_CONNECTION, parsed.message, HTTP_BAD_REQUEST);
            const saved = await guard(reply, log(request), () => store.create(parsed.input));
            if (!saved.ok) return reply;
            if (!saved.value.ok) {
                return bad(
                    reply,
                    ERROR_CODES.GITLAB_CONNECTION_EXISTS,
                    'This organization already connects that GitLab host',
                    HTTP_CONFLICT
                );
            }
            return reply.code(HTTP_CREATED).send(saved.value.connection);
        });

        app.delete(`${PATH}/:id`, { bodyLimit: CONTROL_BODY_LIMIT }, async (request, reply) => {
            const store = await storeOf(orgs, request, reply);
            if (!store) return reply;
            const id = idOf(request);
            if (!id) return noSuchConnection(reply);
            const removed = await guard(reply, log(request), () => store.remove(id));
            if (!removed.ok) return reply;
            return removed.value ? reply.code(HTTP_OK).send({ ok: true }) : noSuchConnection(reply);
        });
    };
