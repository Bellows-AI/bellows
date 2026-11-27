'use strict';

/*
 * The review-reconcile block's collect body for a GitLab job: review-collect.cjs speaks `gh`, which a GitLab
 * task has no token for (its git asks through the forge mailbox), so the board reads the merge request's
 * discussions as the thread's starter (`GET /api/jobs/:id/agent-review`, docs/workflows.md) and this script only
 * carries the attempt's pair there. The board answers the `review-collect/v1` collection review-collect.cjs would;
 * the unmodified prelude/postlude (review-collect-probe-*.cjs) decide on it. driver/src/review/review-helpers.ts
 * composes the pieces. review-reply-gitlab.cjs reuses the transport and the two settle helpers below, and is only
 * ever composed after this file.
 *
 * `__reviewGitlabCollect()` resolves on EVERY path and writes exactly one JSON line to the (captured) stdout: the
 * collection, or `{ ok: false, schema, version, error }`. A board that does not answer with a collection (a timeout,
 * a reset, a 5xx, a 401, a 404 under AUTH_MODE=none, malformed JSON, another schema) is a refusal, never an empty
 * collection, so it can never read as REVIEW-CLEAN. A 409 with `waiting: true` (the starter's grant is held) also
 * sets `__reviewGitlabWait`, which `__reviewGitlabHeld` turns into the `forge_wait` helper reason: no verdict at all.
 *
 * Environment: FACTORY_STATS_URL, RUNNER_JOB_ID, RUNNER_LEASE_TOKEN (the attempt's pair, never printed);
 * REVIEW_GITLAB_DEADLINE_MS (a test seam: the call's deadline, otherwise REVIEW_GITLAB_COLLECT_DEADLINE_MS).
 */

const REVIEW_GITLAB_COLLECT_DEADLINE_MS = 90000;
const HTTP_OK = 200;
const HTTP_CONFLICT = 409;
// biome-ignore lint/plugin: a container script imports nothing, so it spells the wire values itself
const JSON_CONTENT_TYPE = 'application/json';
// biome-ignore lint/plugin: the same, for the header name
const CONTENT_TYPE_HEADER = 'content-type';
const REVIEW_GITLAB_ERROR_MAX = 300;
const REVIEW_GITLAB_COLLECT_SCHEMA = 'review-collect/v1';

/** A reason string while the board holds the starter's grant, else false. */
let __reviewGitlabWait = false;

function __reviewGitlabLine(line) {
    process.stdout.write(JSON.stringify(line) + '\n');
}

/** One board call: `{ status, text }`, or `{ error }` for anything that is not a complete answer. Never throws. */
async function __reviewGitlabCall(method, route, body, deadlineMs) {
    const base = process.env.FACTORY_STATS_URL;
    const jobId = process.env.RUNNER_JOB_ID;
    const lease = process.env.RUNNER_LEASE_TOKEN;
    if (!base || !jobId || !lease)
        return { error: 'the attempt has no board address or lease to ask the review route with' };
    const override = Number(process.env.REVIEW_GITLAB_DEADLINE_MS);
    const ms = override > 0 ? override : deadlineMs;
    try {
        const res = await fetch(base.replace(/\/+$/, '') + '/api/jobs/' + encodeURIComponent(jobId) + route, {
            method,
            headers: {
                'x-factory-job-id': jobId,
                'x-factory-job-lease-token': lease,
                ...(body === undefined ? {} : { [CONTENT_TYPE_HEADER]: JSON_CONTENT_TYPE }),
            },
            ...(body === undefined ? {} : { body }),
            signal: AbortSignal.timeout(ms),
        });
        return { status: res.status, text: await res.text() };
    } catch (e) {
        return {
            error:
                'the board did not answer: ' +
                String((e && e.message) || e)
                    .split(lease)
                    .join('[lease]'),
        };
    }
}

/** The parsed JSON of a call that answered, or null. */
function __reviewGitlabJson(text) {
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/** Writes the refusal line for a call that is not a 200 answer, and holds the thread's grant when the board says so. */
function __reviewGitlabRefuse(schema, answer) {
    let error = answer.error;
    if (error === undefined) {
        const parsed = __reviewGitlabJson(answer.text);
        error =
            'the board answered ' +
            answer.status +
            (parsed && typeof parsed.message === 'string' ? ': ' + parsed.message : '');
        if (answer.status === HTTP_CONFLICT && parsed && parsed.waiting === true) __reviewGitlabWait = error;
    }
    __reviewGitlabLine({ ok: false, schema, version: 1, error: String(error).slice(0, REVIEW_GITLAB_ERROR_MAX) });
}

/**
 * Whether the board is holding the starter's grant: restores real stdout and emits the `forge_wait` envelope for
 * `schema` (the probe's own), so the caller returns without deciding anything.
 */
function __reviewGitlabHeld(schema) {
    if (!__reviewGitlabWait) return false;
    process.stdout.write = __reviewProbeOriginalWrite;
    console.log(
        JSON.stringify({
            schema,
            version: 1,
            ok: false,
            reason: 'forge_wait',
            error: String(__reviewGitlabWait).slice(0, REVIEW_GITLAB_ERROR_MAX),
        })
    );
    return true;
}

/** The last resort of a composed body: one `runner_error` envelope for a throw nothing else answered. */
function __reviewGitlabCrashed(schema, e) {
    process.stdout.write = __reviewProbeOriginalWrite;
    console.log(
        JSON.stringify({
            schema,
            version: 1,
            ok: false,
            reason: 'runner_error',
            error: String((e && e.message) || e).slice(0, REVIEW_GITLAB_ERROR_MAX),
        })
    );
}

async function __reviewGitlabCollect() {
    const answer = await __reviewGitlabCall('GET', '/agent-review', undefined, REVIEW_GITLAB_COLLECT_DEADLINE_MS);
    if (answer.error !== undefined || answer.status !== HTTP_OK)
        return __reviewGitlabRefuse(REVIEW_GITLAB_COLLECT_SCHEMA, answer);
    const collection = __reviewGitlabJson(answer.text);
    if (!collection || collection.schema !== REVIEW_GITLAB_COLLECT_SCHEMA) {
        return __reviewGitlabRefuse(REVIEW_GITLAB_COLLECT_SCHEMA, {
            error: 'the board answered something that is not a review collection',
        });
    }
    __reviewGitlabLine(collection);
}
