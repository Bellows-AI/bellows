import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import {
    DEFAULT_ROTATION_OVERLAP_SECONDS,
    type DriverCredentialStore,
    MAX_LABEL_LENGTH,
    MAX_ROTATION_OVERLAP_SECONDS,
    type RotateOutcome,
} from '../auth/driver-credentials.js';
import { callerOf } from '../auth/plugin.js';
import { bad, body, guard } from './helpers.js';

/**
 * The board operator's driver credentials (docs/auth.md): `GET /api/operator/driver-credentials` lists them (never a
 * token or hash), `POST /api/operator/driver-credentials` issues one for `orgs` or the `pool` (201, the token shown
 * this once), and `POST …/:id/revoke` and `POST …/:id/rotate` (`overlapSeconds`, default one hour) revoke or replace
 * one. Every route is an `operator` row in ROUTE_CLASSES, so the auth hook refuses anyone `OPERATOR_GITHUB_IDS` does
 * not name before these run. Without a credential store the routes answer 503.
 */

const HTTP_CREATED = 201;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_UNAVAILABLE = 503;

const PATH = '/api/operator/driver-credentials';
/** Bounds the issue's org list; a driver serving more organizations than this is a pool driver. */
const MAX_ORGS = 1000;

type Scope = { ok: true; label: string; orgs: string[] | null } | { ok: false; message: string };

function scopeOf(raw: unknown): Scope {
    const { label, orgs, pool } = body(raw);
    if (typeof label !== 'string' || !label.trim() || label.trim().length > MAX_LABEL_LENGTH) {
        return { ok: false, message: `label must be 1..${MAX_LABEL_LENGTH} characters` };
    }
    if (pool === true && orgs === undefined) return { ok: true, label: label.trim(), orgs: null };
    if (pool !== undefined && pool !== false) return { ok: false, message: 'name either orgs or pool: true, not both' };
    if (
        !Array.isArray(orgs) ||
        orgs.length < 1 ||
        orgs.length > MAX_ORGS ||
        orgs.some((org) => typeof org !== 'string' || !org)
    ) {
        return { ok: false, message: `orgs must be 1..${MAX_ORGS} organization ids, or pass pool: true` };
    }
    return { ok: true, label: label.trim(), orgs: orgs as string[] };
}

function overlapOf(raw: unknown): number | null {
    const { overlapSeconds } = body(raw);
    if (overlapSeconds === undefined) return DEFAULT_ROTATION_OVERLAP_SECONDS;
    if (!Number.isInteger(overlapSeconds)) return null;
    const seconds = overlapSeconds as number;
    return seconds >= 0 && seconds <= MAX_ROTATION_OVERLAP_SECONDS ? seconds : null;
}

const unavailable = (reply: FastifyReply) =>
    bad(reply, ERROR_CODES.UNAVAILABLE, 'Driver credentials are not available', HTTP_UNAVAILABLE);

const noCredential = (reply: FastifyReply, id: string) =>
    bad(reply, ERROR_CODES.NOT_FOUND, `No driver credential '${id}'`, HTTP_NOT_FOUND);

export const operatorDriverCredentialRoutes =
    ({ credentials }: { credentials: DriverCredentialStore | undefined }): FastifyPluginAsync =>
    async (app) => {
        app.get(PATH, async (request, reply) => {
            if (!credentials) return unavailable(reply);
            const listed = await guard(
                reply,
                (e) => request.log.error(e),
                () => credentials.list()
            );
            if (listed.ok) return { credentials: listed.value };
        });

        app.post(PATH, async (request, reply) => {
            const caller = callerOf(request);
            if (!caller) return bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
            if (!credentials) return unavailable(reply);
            const scope = scopeOf(request.body);
            if (!scope.ok) return bad(reply, ERROR_CODES.BAD_BODY, scope.message);
            const done = await guard(
                reply,
                (e) => request.log.error(e),
                () => credentials.issue({ label: scope.label, orgs: scope.orgs, createdBy: caller.user.id })
            );
            if (!done.ok) return;
            const issued = done.value;
            if (issued.outcome === 'missing-org') {
                return bad(reply, ERROR_CODES.NOT_FOUND, `No organization '${issued.orgId}'`, HTTP_NOT_FOUND);
            }
            request.log.info({ credential: issued.credential.id, by: caller.user.id }, 'driver credential issued');
            return reply.code(HTTP_CREATED).send({ credential: issued.credential, token: issued.token });
        });

        app.post<{ Params: { id: string } }>(`${PATH}/:id/revoke`, async (request, reply) => {
            const caller = callerOf(request);
            if (!caller) return bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
            if (!credentials) return unavailable(reply);
            const { id } = request.params;
            const done = await guard(
                reply,
                (e) => request.log.error(e),
                () => credentials.revoke(id)
            );
            if (!done.ok) return;
            const revoked = done.value;
            if (revoked.outcome === 'missing') return noCredential(reply, id);
            request.log.info({ credential: id, by: caller.user.id }, 'driver credential revoked');
            return { revoked: revoked.outcome === 'revoked', credential: revoked.credential };
        });

        app.post<{ Params: { id: string } }>(`${PATH}/:id/rotate`, async (request, reply) => {
            const caller = callerOf(request);
            if (!caller) return bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
            if (!credentials) return unavailable(reply);
            const overlap = overlapOf(request.body);
            if (overlap === null) {
                return bad(
                    reply,
                    ERROR_CODES.BAD_BODY,
                    `overlapSeconds must be a whole number 0..${MAX_ROTATION_OVERLAP_SECONDS}`
                );
            }
            const { id } = request.params;
            const done = await guard(
                reply,
                (e) => request.log.error(e),
                () => credentials.rotate(id, overlap, caller.user.id)
            );
            if (!done.ok) return;
            const rotated = done.value;
            if (rotated.outcome === 'rotated') {
                request.log.info(
                    { credential: rotated.credential.id, rotatedFrom: id, by: caller.user.id },
                    'driver credential rotated'
                );
            }
            return rotateAnswer(reply, id, rotated);
        });
    };

/** The answer to a rotation: the successor and its token (201), 404 for an unknown id, 409 for an inactive one. */
function rotateAnswer(reply: FastifyReply, id: string, rotated: RotateOutcome) {
    if (rotated.outcome === 'missing') return noCredential(reply, id);
    if (rotated.outcome === 'inactive') {
        return reply.code(HTTP_CONFLICT).send({
            error: 'A revoked or already rotated driver credential cannot be rotated',
            code: ERROR_CODES.DRIVER_CREDENTIAL_INACTIVE,
            credential: rotated.credential,
        });
    }
    return reply
        .code(HTTP_CREATED)
        .send({ credential: rotated.credential, previous: rotated.previous, token: rotated.token });
}
