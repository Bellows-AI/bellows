import { randomBytes } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { parseClientMetadata, type ClientMetadata } from '../oauth/client-metadata.js';
import { createRateLimiter } from '../oauth/rate-limit.js';
import {
    HTTP_BAD_REQUEST,
    HTTP_UNAVAILABLE,
    OAUTH_PATHS,
    noStore,
    oauthError,
    type OAuthRouteDeps,
} from './oauth-http.js';

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const bad = (error: 'invalid_client_metadata', description: string) => ({ ok: false, error, description }) as const;

const HTTP_CREATED = 201;
const HTTP_TOO_MANY = 429;
const BODY_LIMIT = 16_384;
const HOUR_MS = 3_600_000;
const ID_BYTES = 18;
const MS = 1000;
const PER_ADDRESS = 20;
const TOTAL = 300;

export interface RegistrationLimits {
    perAddress: number;
    total: number;
    windowMs: number;
}
export const DEFAULT_REGISTRATION_LIMITS: RegistrationLimits = {
    perAddress: PER_ADDRESS,
    total: TOTAL,
    windowMs: HOUR_MS,
};

/**
 * RFC 7591 Dynamic Client Registration for public clients: unauthenticated, so bounded twice (per caller address and
 * for the whole replica, in this process only) and stored as a `dcr` client that expires after 30 unused days. The
 * client id is generated here; a registration never names its own.
 */
export const oauthRegisterRoutes =
    ({ oauth, registrationLimits = DEFAULT_REGISTRATION_LIMITS }: OAuthRouteDeps): FastifyPluginAsync =>
    async (app) => {
        const { windowMs } = registrationLimits;
        const perAddress = createRateLimiter({ limit: registrationLimits.perAddress, windowMs });
        const total = createRateLimiter({ limit: registrationLimits.total, windowMs });

        /** A 429 when this caller or the replica is over its window, else null. */
        const overLimit = (ip: string) => {
            const verdicts = [perAddress.hit(ip), total.hit('*')];
            return verdicts.find((verdict) => !verdict.ok) ?? null;
        };

        const created = (reply: FastifyReply, clientId: string, parsed: Extract<ClientMetadata, { ok: true }>) =>
            reply.code(HTTP_CREATED).send({
                client_id: clientId,
                client_id_issued_at: Math.floor(Date.now() / MS),
                ...(parsed.name ? { client_name: parsed.name } : {}),
                redirect_uris: parsed.redirectUris,
                ...parsed.metadata,
            });

        const tooMany = (reply: FastifyReply, retryAfterSeconds: number) =>
            reply
                .header('retry-after', String(retryAfterSeconds))
                .code(HTTP_TOO_MANY)
                .send({ error: 'temporarily_unavailable', error_description: 'Too many registrations.' });

        app.post(OAUTH_PATHS.register, { bodyLimit: BODY_LIMIT }, async (request, reply) => {
            noStore(reply);
            const refused = overLimit(request.ip);
            if (refused && !refused.ok) return tooMany(reply, refused.retryAfterSeconds);
            const parsed = isObject(request.body)
                ? parseClientMetadata(request.body)
                : bad('invalid_client_metadata', 'The body must be a JSON object.');
            if (!parsed.ok) return oauthError(reply, HTTP_BAD_REQUEST, parsed.error, parsed.description);
            const clientId = `dcr_${randomBytes(ID_BYTES).toString('base64url')}`;
            try {
                const { name, redirectUris, metadata } = parsed;
                await oauth.upsertClient({ clientId, kind: 'dcr', name, redirectUris, metadata });
            } catch (e) {
                app.log.error({ err: e }, 'oauth registration could not be stored');
                return oauthError(reply, HTTP_UNAVAILABLE, 'temporarily_unavailable', 'Try again shortly.');
            }
            return created(reply, clientId, parsed);
        });
    };
