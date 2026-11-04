import type { AuthInfo } from '@modelcontextprotocol/server';
import type { FastifyRequest } from 'fastify';

const resolved = new WeakMap<object, AuthInfo>();

/** Set by the auth gate for a request it let through; read by the route. Keyed by request, never by header. */
export const setAuthInfo = (request: FastifyRequest, info: AuthInfo): void => {
    resolved.set(request.raw, info);
};

export const authInfoOf = (request: FastifyRequest): AuthInfo | undefined => resolved.get(request.raw);
