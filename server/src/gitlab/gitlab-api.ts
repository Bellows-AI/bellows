import { JSON_CONTENT_TYPE } from '@factory-ai/core';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/**
 * The board's GitLab HTTP client. Only the unauthenticated reachability probe exists so far: the authenticated
 * calls (version check, projects) arrive with the member and admin grants (docs/connections.md).
 */

/** How long one probe may take, connect to last byte. */
export const GITLAB_PROBE_TIMEOUT_MS = 10_000;
/** A probe reads a version document; anything past this is not one. */
const BYTES_PER_KIB = 1024;
const PROBE_BODY_KIB = 64;
const PROBE_BODY_LIMIT = PROBE_BODY_KIB * BYTES_PER_KIB;
const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_SERVER_ERROR = 500;

/** Why an instance was not confirmed reachable; closed, so the row, the route and the UI share it. */
export const PROBE_REASONS = ['timeout', 'unreachable', 'tls', 'server-error', 'malformed'] as const;
export type ProbeReason = (typeof PROBE_REASONS)[number];

export type ProbeResult = { reachable: true; version: string | null } | { reachable: false; reason: ProbeReason };

export interface GitlabApi {
    /**
     * `GET /api/v4/version` with no credential. GitLab answers 401 JSON to an anonymous caller, which proves the API
     * is there; a 200 also names the version. Never throws: every failure is a reason.
     */
    probe(target: { host: string; caBundle?: string | undefined }): Promise<ProbeResult>;
}

const TLS_CODES = new Set([
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'CERT_HAS_EXPIRED',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'CERT_NOT_YET_VALID',
]);

const failureOf = (error: unknown): ProbeReason => {
    const code = (error as { code?: string }).code ?? '';
    return TLS_CODES.has(code) || code.startsWith('ERR_SSL') || code.startsWith('CERT_') ? 'tls' : 'unreachable';
};

const jsonOf = (text: string): unknown => {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
};

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

function judge(status: number, text: string): ProbeResult {
    if (status >= HTTP_SERVER_ERROR) return { reachable: false, reason: 'server-error' };
    const body = jsonOf(text);
    if (status === HTTP_OK && isObject(body) && typeof body.version === 'string') {
        return { reachable: true, version: body.version };
    }
    if (status === HTTP_UNAUTHORIZED && isObject(body) && typeof body.message === 'string') {
        return { reachable: true, version: null };
    }
    return { reachable: false, reason: 'malformed' };
}

export function createGitlabApi({
    baseUrl = (host) => `https://${host}`,
    probeTimeoutMs = GITLAB_PROBE_TIMEOUT_MS,
}: {
    /** The origin a host is reached at; `https` always, a test points it at the fake. */
    baseUrl?: (host: string) => string;
    probeTimeoutMs?: number;
} = {}): GitlabApi {
    return {
        probe: ({ host, caBundle }) =>
            new Promise<ProbeResult>((resolve) => {
                let url: URL;
                try {
                    url = new URL('/api/v4/version', baseUrl(host));
                } catch {
                    // An input the route let through that no URL can name: pending, with a reason, never a throw.
                    return resolve({ reachable: false, reason: 'unreachable' });
                }
                const send = url.protocol === 'http:' ? httpRequest : httpsRequest;
                let settled = false;
                const done = (result: ProbeResult) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    req.destroy();
                    resolve(result);
                };
                const timer = setTimeout(() => done({ reachable: false, reason: 'timeout' }), probeTimeoutMs);
                const req = send(url, {
                    method: 'GET',
                    headers: { accept: JSON_CONTENT_TYPE },
                    ...(caBundle === undefined ? {} : { ca: caBundle }),
                });
                req.on('error', (error) => done({ reachable: false, reason: failureOf(error) }));
                req.on('response', (response) => {
                    const chunks: Buffer[] = [];
                    let size = 0;
                    response.on('data', (chunk: Buffer) => {
                        size += chunk.length;
                        if (size > PROBE_BODY_LIMIT) return done({ reachable: false, reason: 'malformed' });
                        chunks.push(chunk);
                    });
                    response.on('end', () =>
                        done(judge(response.statusCode ?? 0, Buffer.concat(chunks).toString('utf8')))
                    );
                    response.on('error', (error) => done({ reachable: false, reason: failureOf(error) }));
                });
                req.end();
            }),
    };
}
