import { CONTENT_TYPE_HEADER, JSON_CONTENT_TYPE, type RepoRef } from '@factory-ai/core';
import type { GitlabApi, ProbeReason } from '../gitlab/gitlab-api.js';

/**
 * One request to a GitLab instance as one member's token (docs/gitlab.md): the shared transport of the read and merge
 * modules and the adapter's writes. It answers what came back and classifies nothing; every caller decides what a status
 * means for it. The token is in no answer and no error text.
 */

const BYTES_PER_KIB = 1024;
/** A page of merge requests carries their descriptions: far past a version document. */
export const GITLAB_BODY_LIMIT_BYTES = 2 * BYTES_PER_KIB * BYTES_PER_KIB;
const HTTP_OK = 200;
const HTTP_MULTIPLE_CHOICES = 300;

export const NO_TOKEN = 'no-token';

export type GitlabAnswer =
    /** `json` is the parsed body: of a 2xx always, of any other status when it parses (else null). */
    | { ok: true; status: number; json: unknown; text: string }
    /** `sent` is false only when the request provably never reached the instance; a 2xx that is not JSON is `malformed`. */
    | { ok: false; reason: ProbeReason | typeof NO_TOKEN; sent: boolean };

export type GitlabCall = (
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    signal: AbortSignal,
    body?: object
) => Promise<GitlabAnswer>;

export const isSuccess = (status: number): boolean => status >= HTTP_OK && status < HTTP_MULTIPLE_CHOICES;

function parsed(text: string): { ok: true; json: unknown } | { ok: false } {
    try {
        return { ok: true, json: JSON.parse(text) };
    } catch {
        return { ok: false };
    }
}

export function gitlabRequest(
    deps: { api: GitlabApi; caBundle: string | undefined },
    ref: RepoRef,
    token: string | null
): GitlabCall {
    return async (method, path, signal, body) => {
        if (token === null) return { ok: false, reason: NO_TOKEN, sent: false };
        const answer = await deps.api.request({
            host: ref.host,
            path,
            method,
            headers: {
                authorization: `Bearer ${token}`,
                ...(body === undefined ? {} : { [CONTENT_TYPE_HEADER]: JSON_CONTENT_TYPE }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            caBundle: deps.caBundle,
            signal,
            maxBytes: GITLAB_BODY_LIMIT_BYTES,
        });
        if (!answer.ok) return answer;
        const read = parsed(answer.text);
        if (!read.ok && isSuccess(answer.status)) return { ok: false, reason: 'malformed', sent: true };
        return { ok: true, status: answer.status, json: read.ok ? read.json : null, text: answer.text };
    };
}
