import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { InvalidArtifactError, MANIFEST_STATES, type ManifestState } from '../artifacts/artifact-store.js';
import type { StreamRef } from '../artifacts/keys.js';
import type { OrgRegistry } from '../orgs.js';
import { artifactsFor } from './job-context.js';
import { HTTP_CONFLICT, HTTP_OK, HTTP_PAYLOAD_TOO_LARGE, HTTP_UNAVAILABLE, notFoundJob } from './job-limits.js';
import { bad, body, guard } from './helpers.js';
import { resolveJobRoute } from './route-guards.js';

/**
 * The artifact upload routes: a chunk put and a manifest finalize against the artifact index
 * (070). They are authorized by CLAIM SEQUENCE, not by the live lease: the driver names the claim
 * it ran under, the board accepts any claim that has existed (1 through the row's current one) and
 * files the bytes under that claim's own prefix. So a superseded or reclaimed attempt can finish
 * its uploads, and because nothing here touches `job` — no status, session, gates, verdict or
 * publication — finishing them advances no authoritative state.
 */

/** What a job with no author is filed under: the key layout names a member, and ids only. */
export const UNATTRIBUTED_MEMBER = 'unattributed';

const NO_STORE_MESSAGE = 'No artifact store is configured';

type Query = Record<string, string | undefined>;

const parseCount = (raw: unknown): number | null =>
    typeof raw === 'string' && /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null;

/**
 * The stream a request names, below the job: executor, session and stream come from the caller,
 * member and root from the row. Null once a refusal has landed on `reply`.
 */
async function resolveStream(
    orgs: OrgRegistry,
    request: FastifyRequest,
    reply: FastifyReply,
    named: Record<string, unknown>
) {
    const route = await resolveJobRoute(orgs, request, reply);
    if (!route) return null;
    const artifacts = await artifactsFor(orgs, request);
    if (!artifacts) {
        await bad(reply, ERROR_CODES.ARTIFACTS_UNAVAILABLE, NO_STORE_MESSAGE, HTTP_UNAVAILABLE);
        return null;
    }
    const { executor, session, stream } = named;
    if (typeof executor !== 'string' || typeof session !== 'string' || typeof stream !== 'string') {
        await bad(reply, ERROR_CODES.BAD_ARTIFACT, 'executor, session and stream are required');
        return null;
    }
    const claimSeq = typeof named.claimSeq === 'number' ? named.claimSeq : parseCount(named.claimSeq);
    const scope = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'artifact scope read failed'),
        () => route.store.artifactScope(route.id)
    );
    if (!scope.ok) return null;
    if (!scope.value) {
        await notFoundJob(reply);
        return null;
    }
    // The whole authorization: a claim that has existed. A claim ahead of the row's has not been
    // made, so nobody holds it.
    if (claimSeq === null || !Number.isInteger(claimSeq) || claimSeq < 1 || claimSeq > scope.value.claimSeq) {
        await bad(
            reply,
            ERROR_CODES.BAD_CLAIM_SEQ,
            `claimSeq must be a claim of this job (1 to ${scope.value.claimSeq})`
        );
        return null;
    }
    const ref: StreamRef = {
        member: scope.value.member ?? UNATTRIBUTED_MEMBER,
        root: scope.value.root,
        job: route.id,
        claimSeq,
        executor,
        session,
        stream,
    };
    return { artifacts, ref };
}

/** Runs one index call: a malformed request is a 400, a store failure the usual 503; null once either was sent. */
async function indexCall<T>(reply: FastifyReply, request: FastifyRequest, run: () => Promise<T>): Promise<T | null> {
    const result = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'artifact write failed'),
        async () => {
            try {
                return await run();
            } catch (e) {
                if (e instanceof InvalidArtifactError) return e;
                throw e;
            }
        }
    );
    if (!result.ok) return null;
    if (result.value instanceof InvalidArtifactError) {
        await bad(reply, ERROR_CODES.BAD_ARTIFACT, result.value.message);
        return null;
    }
    return result.value;
}

/** `PUT /api/jobs/:id/artifact/chunk` — the raw bytes of one chunk at a source offset; stored once. */
export async function handleArtifactChunk(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const query = request.query as Query;
    const offset = parseCount(query.offset);
    const resolved = await resolveStream(orgs, request, reply, query);
    if (!resolved) return reply;
    if (offset === null || !Buffer.isBuffer(request.body)) {
        return bad(reply, ERROR_CODES.BAD_ARTIFACT, 'offset and a raw chunk body are required');
    }
    const { artifacts, ref } = resolved;
    const chunk = request.body;
    const put = await indexCall(reply, request, () => artifacts.putChunk(ref, offset, chunk));
    if (!put) return reply;
    if (put.result === 'conflict') {
        return bad(
            reply,
            ERROR_CODES.ARTIFACT_CONFLICT,
            'a different chunk is already stored at this offset',
            HTTP_CONFLICT
        );
    }
    if (put.result === 'refused') {
        return reply.code(HTTP_PAYLOAD_TOO_LARGE).send({
            error: `the chunk was refused: ${put.cause}`,
            code: ERROR_CODES.ARTIFACT_REFUSED,
            cause: put.cause,
        });
    }
    return reply.code(HTTP_OK).send({ result: put.result, offset });
}

const parseTime = (raw: unknown): Date | null => {
    if (typeof raw !== 'string') return null;
    const at = new Date(raw);
    return Number.isNaN(at.getTime()) ? null : at;
};

/** `PUT /api/jobs/:id/artifact/manifest` — closes one stream; a repeat of the same manifest is a no-op. */
export async function handleArtifactManifest(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const fields = body(request.body);
    const resolved = await resolveStream(orgs, request, reply, fields);
    if (!resolved) return reply;
    const { producer, schemaVersion, state, terminalCause } = fields;
    const startedAt = parseTime(fields.startedAt);
    const finishedAt = parseTime(fields.finishedAt);
    if (
        typeof producer !== 'string' ||
        typeof schemaVersion !== 'number' ||
        typeof state !== 'string' ||
        !MANIFEST_STATES.includes(state as ManifestState) ||
        (terminalCause !== undefined && terminalCause !== null && typeof terminalCause !== 'string') ||
        !startedAt ||
        !finishedAt
    ) {
        return bad(reply, ERROR_CODES.BAD_ARTIFACT, 'a manifest needs producer, schemaVersion, state and both times');
    }
    const { artifacts, ref } = resolved;
    const manifest = {
        producer,
        schemaVersion,
        startedAt,
        finishedAt,
        state: state as ManifestState,
        terminalCause: terminalCause ?? null,
    };
    const done = await indexCall(reply, request, () => artifacts.finalize(ref, manifest));
    if (!done) return reply;
    if (done.result === 'conflict') {
        return bad(reply, ERROR_CODES.ARTIFACT_CONFLICT, 'a different manifest is already recorded', HTTP_CONFLICT);
    }
    return reply.code(HTTP_OK).send({ result: done.result });
}
