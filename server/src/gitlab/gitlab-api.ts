import { JSON_CONTENT_TYPE, REPO_PATH_PATTERN } from '@factory-ai/core';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/**
 * The board's GitLab HTTP client: the unauthenticated reachability probe, the authenticated version check that
 * activates a connection, the bounded request the OAuth hooks call the token and user endpoints with, the group
 * project listing the admin picks tracked repos from and the member's project access check the start gate asks
 * (docs/connections.md). Every call is deadline-bound, reads at most 64 KiB and is CA-aware.
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

/** The lowest GitLab the board activates a connection against. */
export const GITLAB_MIN_VERSION = { major: 17, minor: 0 } as const;

export interface GitlabRequest {
    host: string;
    /** A path under the instance origin, query included. */
    path: string;
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
    caBundle?: string | undefined;
    signal?: AbortSignal | undefined;
    /** The most the answer may carry; a longer one is `malformed`. Defaults to 64 KiB, a version document's size. */
    maxBytes?: number;
}

/** An answer, whatever its status; or why no answer was had. Never throws. */
export type GitlabResponse =
    | { ok: true; status: number; text: string }
    /** `sent` is false only when the request provably never reached the instance (connect or TLS handshake failed). */
    | { ok: false; reason: ProbeReason; sent: boolean };

/**
 * What the authenticated `/version` said. `too-old` is a verdict about the instance; `inconclusive` is any answer that
 * is not one (unreachable, 5xx, a refused token, a malformed body): the caller leaves the connection pending.
 */
export type VersionCheck =
    | { ok: true; version: string }
    | { ok: false; reason: 'too-old'; version: string }
    | { ok: false; reason: 'inconclusive' };

/** The access level that may push to a project: GitLab's Developer. */
export const GITLAB_DEVELOPER_LEVEL = 30;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
/** Projects asked per page, and the most pages one listing reads before it is called unconfirmed. */
const DEFAULT_PAGE_SIZE = 100;
/** A page of projects is far past a version document: 100 `simple` entries are tens of KiB. */
const LIST_BODY_MIB = 2;
const LIST_BODY_LIMIT = LIST_BODY_MIB * BYTES_PER_KIB * BYTES_PER_KIB;
const MAX_LIST_PAGES = 100;

export interface GitlabProject {
    /** `path_with_namespace`: the group chain and the project. */
    path: string;
    defaultBranch: string | null;
}

/** Every project, or no listing at all: a page that did not answer cleanly leaves nothing partial to act on. */
export type ProjectListing = { ok: true; projects: GitlabProject[] } | { ok: false };

/**
 * The most access the token's user holds on a project (its own and its groups', 0 for none): GitLab's answer, a
 * 403 or a 404 (the project is invisible to them). Anything else, a 401 included, is `inconclusive`: no verdict.
 */
export type ProjectAccess = { ok: true; level: number } | { ok: false; reason: 'inconclusive' };

interface Target {
    host: string;
    token: string;
    caBundle?: string | undefined;
    signal?: AbortSignal | undefined;
}

export interface GitlabApi {
    /** One bounded request; every failure is a reason, never a throw. */
    request(request: GitlabRequest): Promise<GitlabResponse>;
    /** `GET /api/v4/version` with the token; the minimum is `GITLAB_MIN_VERSION`. */
    checkVersion(target: {
        host: string;
        token: string;
        caBundle?: string | undefined;
        signal?: AbortSignal | undefined;
    }): Promise<VersionCheck>;
    /**
     * Every project the token's user sees under `group`, subgroups included, read page by page. A group the user
     * cannot see lists nothing; a failed, malformed or over-long read is `ok: false`.
     */
    listGroupProjects(target: Target & { group: string }): Promise<ProjectListing>;
    /** What the token's user holds on the project (`GET /api/v4/projects/:path`), as `ProjectAccess`. */
    projectAccess(target: Target & { project: string }): Promise<ProjectAccess>;
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

/** Errors raised before a request could have been written: no connection, or no TLS session to write it on. */
const CONNECT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);
const neverSent = (error: unknown): boolean => {
    const code = (error as { code?: string }).code ?? '';
    return CONNECT_CODES.has(code) || failureOf(error) === 'tls';
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

const VERSION_PATTERN = /^(\d+)\.(\d+)/;

/** The verdict on a version string: null when it is not a version at all. */
function versionVerdict(version: string): VersionCheck | null {
    const match = VERSION_PATTERN.exec(version);
    if (!match) return null;
    const [major, minor] = [Number(match[1]), Number(match[2])];
    const old =
        major < GITLAB_MIN_VERSION.major || (major === GITLAB_MIN_VERSION.major && minor < GITLAB_MIN_VERSION.minor);
    return old ? { ok: false, reason: 'too-old', version } : { ok: true, version };
}

const levelOf = (access: unknown): number | null => {
    if (access === null) return 0;
    if (!isObject(access)) return null;
    return Number.isInteger(access.access_level) ? (access.access_level as number) : null;
};

/** A project the listing may carry: a path the board can hold, and a default branch or none. */
function projectOf(item: unknown): GitlabProject | null {
    if (!isObject(item)) return null;
    const { path_with_namespace: path, default_branch: branch } = item;
    if (typeof path !== 'string' || !REPO_PATH_PATTERN.test(path)) return null;
    if (branch !== null && branch !== undefined && typeof branch !== 'string') return null;
    return { path, defaultBranch: branch ?? null };
}

type Send = (request: GitlabRequest) => Promise<GitlabResponse>;

const authorized = (token: string) => ({ authorization: `Bearer ${token}` });

/**
 * One listing page's projects; `null` for an answer that is not a clean page. A 404 is an empty listing (no such group)
 * only on the first page: once pagination started, a 404 is no answer, and the pages read so far are discarded.
 */
function pageOf(answer: GitlabResponse, first: boolean): GitlabProject[] | null {
    if (!answer.ok) return null;
    if (answer.status === HTTP_NOT_FOUND) return first ? [] : null;
    const body = answer.status === HTTP_OK ? jsonOf(answer.text) : undefined;
    if (!Array.isArray(body)) return null;
    const projects = body.map(projectOf);
    return projects.every((project) => project !== null) ? projects : null;
}

async function listGroupProjects(
    send: Send,
    pageSize: number,
    { host, token, caBundle, signal, group }: Target & { group: string }
): Promise<ProjectListing> {
    const projects = new Map<string, GitlabProject>();
    for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
        const query = new URLSearchParams({
            include_subgroups: 'true',
            simple: 'true',
            archived: 'false',
            per_page: String(pageSize),
            page: String(page),
        });
        const path = `/api/v4/groups/${encodeURIComponent(group)}/projects?${query}`;
        const read = pageOf(
            await send({ host, path, headers: authorized(token), caBundle, signal, maxBytes: LIST_BODY_LIMIT }),
            page === 1
        );
        if (read === null) return { ok: false };
        for (const project of read) projects.set(project.path, project);
        if (read.length < pageSize) return { ok: true, projects: [...projects.values()] };
    }
    return { ok: false };
}

async function projectAccess(
    send: Send,
    { host, token, caBundle, signal, project }: Target & { project: string }
): Promise<ProjectAccess> {
    const path = `/api/v4/projects/${encodeURIComponent(project)}`;
    const answer = await send({ host, path, headers: authorized(token), caBundle, signal });
    if (!answer.ok) return { ok: false, reason: 'inconclusive' };
    if (answer.status === HTTP_FORBIDDEN || answer.status === HTTP_NOT_FOUND) return { ok: true, level: 0 };
    const body = answer.status === HTTP_OK ? jsonOf(answer.text) : undefined;
    const permissions = isObject(body) && isObject(body.permissions) ? body.permissions : null;
    const levels = permissions && [levelOf(permissions.project_access), levelOf(permissions.group_access)];
    if (!levels || levels.includes(null)) return { ok: false, reason: 'inconclusive' };
    return { ok: true, level: Math.max(...(levels as number[])) };
}

export function createGitlabApi({
    baseUrl = (host) => `https://${host}`,
    probeTimeoutMs = GITLAB_PROBE_TIMEOUT_MS,
    pageSize = DEFAULT_PAGE_SIZE,
}: {
    /** The origin a host is reached at; `https` always, a test points it at the fake. */
    baseUrl?: (host: string) => string;
    probeTimeoutMs?: number;
    /** Projects asked per listing page. */
    pageSize?: number;
} = {}): GitlabApi {
    const request = ({
        host,
        path,
        method = 'GET',
        headers = {},
        body,
        caBundle,
        signal,
        maxBytes = PROBE_BODY_LIMIT,
    }: GitlabRequest) =>
        new Promise<GitlabResponse>((resolve) => {
            let url: URL;
            try {
                url = new URL(path, baseUrl(host));
            } catch {
                // An input the route let through that no URL can name: unreachable, never a throw.
                return resolve({ ok: false, reason: 'unreachable', sent: false });
            }
            if (signal?.aborted) return resolve({ ok: false, reason: 'timeout', sent: false });
            const send = url.protocol === 'http:' ? httpRequest : httpsRequest;
            let settled = false;
            const done = (result: GitlabResponse) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                req.destroy();
                resolve(result);
            };
            // Whether the request may have reached the instance: it was handed to a connection that was open, or its own
            // write finished. Never inferred from a pooled socket's events: every request has a connection of its own.
            let connected = false;
            const possiblySent = () => connected || req.writableFinished;
            const onAbort = () => done({ ok: false, reason: 'timeout', sent: possiblySent() });
            const timer = setTimeout(
                () => done({ ok: false, reason: 'timeout', sent: possiblySent() }),
                probeTimeoutMs
            );
            signal?.addEventListener('abort', onAbort, { once: true });
            const req = send(url, {
                method,
                // No keep-alive pool: a reused socket raises no connect event, so "sent" could not be told from "not".
                agent: false,
                headers: {
                    accept: JSON_CONTENT_TYPE,
                    ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }),
                    ...headers,
                },
                ...(caBundle === undefined ? {} : { ca: caBundle }),
            });
            req.on('socket', (socket) => {
                socket.once(url.protocol === 'http:' ? 'connect' : 'secureConnect', () => {
                    connected = true;
                });
            });
            req.on('error', (error) =>
                done({ ok: false, reason: failureOf(error), sent: possiblySent() || !neverSent(error) })
            );
            req.on('response', (response) => {
                const chunks: Buffer[] = [];
                let size = 0;
                response.on('data', (chunk: Buffer) => {
                    size += chunk.length;
                    if (size > maxBytes) return done({ ok: false, reason: 'malformed', sent: true });
                    chunks.push(chunk);
                });
                response.on('end', () =>
                    done({
                        ok: true,
                        status: response.statusCode ?? 0,
                        text: Buffer.concat(chunks).toString('utf8'),
                    })
                );
                response.on('error', (error) => done({ ok: false, reason: failureOf(error), sent: true }));
            });
            req.end(body);
        });
    return {
        request,
        listGroupProjects: (target) => listGroupProjects(request, pageSize, target),
        projectAccess: (target) => projectAccess(request, target),
        probe: async ({ host, caBundle }) => {
            const answer = await request({ host, path: '/api/v4/version', caBundle });
            return answer.ok ? judge(answer.status, answer.text) : { reachable: false, reason: answer.reason };
        },
        checkVersion: async ({ host, token, caBundle, signal }) => {
            const answer = await request({
                host,
                path: '/api/v4/version',
                headers: { authorization: `Bearer ${token}` },
                caBundle,
                signal,
            });
            if (!answer.ok || answer.status !== HTTP_OK) return { ok: false, reason: 'inconclusive' };
            const body = jsonOf(answer.text);
            const verdict = isObject(body) && typeof body.version === 'string' ? versionVerdict(body.version) : null;
            return verdict ?? { ok: false, reason: 'inconclusive' };
        },
    };
}
