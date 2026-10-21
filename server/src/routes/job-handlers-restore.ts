import { CLAUDE_CODE, CONTENT_TYPE_HEADER, ERROR_CODES, OCTET_STREAM_CONTENT_TYPE } from '@factory-ai/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { UUID } from '../config.js';
import { ArtifactObjectMissingError, CHECKPOINT_STREAM, type ArtifactStore } from '../artifacts/artifact-store.js';
import { isKeySegment, type StreamRef } from '../artifacts/keys.js';
import type { RestoreScope } from '../db/restore-types.js';
import type { OrgRegistry } from '../orgs.js';
import { artifactsFor } from './job-context.js';
import { CONTROL_BODY_LIMIT, HTTP_NOT_FOUND, HTTP_OK, HTTP_UNAVAILABLE, leaseLost, notFoundJob } from './job-limits.js';
import { bad, body, guard } from './helpers.js';
import { resolveJobRoute } from './route-guards.js';

/**
 * The restore reads (issue #775): what a driver preparing a restored task volume reads of ITS OWN
 * thread — the root's checkpoint stream and the raw Claude transcripts of every row. Each is a POST
 * authorized by the job's live lease (`leaseToken` in the body, like `review-read`): a lost or
 * foreign lease, or a job the org does not hold, reads nothing. Reads are chunk-wise — a listing
 * names the chunks, one request fetches one — so no response exceeds the artifact chunk cap.
 */

const RAW_TRANSCRIPT_STREAM = 'transcript-raw';
/** The only executor whose raw records rebuild a Claude session file. */
const CLAUDE_EXECUTOR = CLAUDE_CODE;
const UNATTRIBUTED = 'unattributed';

interface Resolved {
    scope: RestoreScope;
    artifacts: ArtifactStore;
    body: Record<string, unknown>;
}

/** The preamble: the live lease's scope and the org's artifact store. Null once a refusal has landed. */
async function resolve(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply): Promise<Resolved | null> {
    const route = await resolveJobRoute(orgs, request, reply);
    if (!route) return null;
    const fields = body(request.body);
    const { leaseToken } = fields;
    if (typeof leaseToken !== 'string' || !UUID.test(leaseToken)) {
        await bad(reply, ERROR_CODES.BAD_TOKEN, 'leaseToken must be a uuid');
        return null;
    }
    const answer = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'restore scope read failed'),
        () => route.store.restoreScope(route.id, leaseToken)
    );
    if (!answer.ok) return null;
    const scoped = answer.value;
    if (scoped.result === 'missing') {
        await notFoundJob(reply);
        return null;
    }
    if (scoped.result === 'lost') {
        await leaseLost(reply);
        return null;
    }
    const artifacts = await artifactsFor(orgs, request);
    if (!artifacts) {
        await bad(reply, ERROR_CODES.ARTIFACTS_UNAVAILABLE, 'No artifact store is configured', HTTP_UNAVAILABLE);
        return null;
    }
    return { scope: scoped.scope, artifacts, body: fields };
}

/** The coordinates alone: a stream summary also carries counts and a manifest, which are no part of a key. */
const refOf = (s: StreamRef): StreamRef => ({
    member: s.member,
    root: s.root,
    job: s.job,
    claimSeq: s.claimSeq,
    executor: s.executor,
    session: s.session,
    stream: s.stream,
});

interface TranscriptStream {
    jobId: string;
    claimSeq: number;
    executor: string;
    session: string;
    bytes: number;
    chunks: { offset: number; length: number; sha256: string }[];
}

const memberOf = (member: string | null) => member ?? UNATTRIBUTED;

async function chunkListing(artifacts: ArtifactStore, ref: StreamRef) {
    const chunks = await artifacts.listChunks(ref);
    return { chunks, bytes: chunks.reduce((n, c) => n + c.length, 0) };
}

/** Sends one stored chunk as bytes, or a 404 when the index or the store no longer has it. */
async function sendChunk(
    request: FastifyRequest,
    reply: FastifyReply,
    want: { artifacts: ArtifactStore; ref: StreamRef; offset: unknown }
) {
    const { artifacts, ref, offset: raw } = want;
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
        return bad(reply, ERROR_CODES.BAD_ARTIFACT, 'offset must be a non-negative integer');
    }
    const read = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'restore chunk read failed'),
        async () => {
            try {
                return await artifacts.readChunk(ref, raw);
            } catch (e) {
                if (e instanceof ArtifactObjectMissingError) return null;
                throw e;
            }
        }
    );
    if (!read.ok) return reply;
    if (!read.value) return bad(reply, ERROR_CODES.NOT_FOUND, 'No such chunk', HTTP_NOT_FOUND);
    return reply
        .code(HTTP_OK)
        .header(CONTENT_TYPE_HEADER, OCTET_STREAM_CONTENT_TYPE)
        .header('x-chunk-sha256', read.value.sha256)
        .send(Buffer.from(read.value.body));
}

/** The pointed checkpoint stream's coordinates, or null when the thread holds no pointer. */
function checkpointRef(scope: RestoreScope): StreamRef | null {
    const pointer = scope.checkpoint;
    const row = scope.jobs.find((j) => j.id === pointer?.jobId);
    if (!pointer || !row) return null;
    return {
        member: memberOf(row.member),
        root: scope.root,
        job: pointer.jobId,
        claimSeq: pointer.claimSeq,
        executor: pointer.executor,
        session: pointer.session,
        stream: CHECKPOINT_STREAM,
    };
}

/** `POST /api/jobs/:id/checkpoint` — `none`, `gone` (pointed, but the stream left the index), or the pointer and its chunk list. */
export async function handleCheckpoint(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const r = await resolve(orgs, request, reply);
    if (!r) return reply;
    const pointer = r.scope.checkpoint;
    if (!pointer) return reply.code(HTTP_OK).send({ state: 'none' });
    const ref = checkpointRef(r.scope);
    const listing = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'checkpoint listing failed'),
        async () => {
            const held = ref ? (await r.artifacts.streamsOfJob(ref.job)).some((s) => sameStream(s, ref)) : false;
            return ref && held ? chunkListing(r.artifacts, ref) : null;
        }
    );
    if (!listing.ok) return reply;
    if (!listing.value || listing.value.chunks.length === 0) return reply.code(HTTP_OK).send({ state: 'gone' });
    return reply.code(HTTP_OK).send({
        state: 'found',
        checkpoint: {
            jobId: pointer.jobId,
            claimSeq: pointer.claimSeq,
            executor: pointer.executor,
            session: pointer.session,
            truncated: pointer.truncated,
            cause: pointer.cause,
            finalizedAt: pointer.finalizedAt,
            ...listing.value,
        },
    });
}

const sameStream = (a: StreamRef, b: StreamRef) =>
    a.claimSeq === b.claimSeq && a.executor === b.executor && a.session === b.session && a.stream === b.stream;

/** `POST /api/jobs/:id/checkpoint/chunk` — one chunk of the pointed stream, by `offset`. */
export async function handleCheckpointChunk(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const r = await resolve(orgs, request, reply);
    if (!r) return reply;
    const ref = checkpointRef(r.scope);
    if (!ref) return bad(reply, ERROR_CODES.NOT_FOUND, 'The thread has no checkpoint', HTTP_NOT_FOUND);
    return sendChunk(request, reply, { artifacts: r.artifacts, ref, offset: r.body.offset });
}

/** `POST /api/jobs/:id/transcripts` — the raw Claude transcript streams of every row of the thread, with their chunks. */
export async function handleTranscripts(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const r = await resolve(orgs, request, reply);
    if (!r) return reply;
    const listed = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'transcript listing failed'),
        async () => {
            const streams: TranscriptStream[] = [];
            for (const row of r.scope.jobs) {
                for (const s of await r.artifacts.streamsOfJob(row.id)) {
                    if (s.stream !== RAW_TRANSCRIPT_STREAM || s.executor !== CLAUDE_EXECUTOR) continue;
                    const { chunks, bytes } = await chunkListing(r.artifacts, refOf(s));
                    streams.push({
                        jobId: row.id,
                        claimSeq: s.claimSeq,
                        executor: s.executor,
                        session: s.session,
                        bytes,
                        chunks,
                    });
                }
            }
            return streams;
        }
    );
    if (!listed.ok) return reply;
    return reply.code(HTTP_OK).send({ streams: listed.value });
}

/** `POST /api/jobs/:id/transcripts/chunk` — one chunk of a raw transcript of a row of THIS thread. */
export async function handleTranscriptChunk(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const r = await resolve(orgs, request, reply);
    if (!r) return reply;
    const { jobId, claimSeq, session, offset } = r.body;
    if (
        typeof jobId !== 'string' ||
        !UUID.test(jobId) ||
        typeof claimSeq !== 'number' ||
        !Number.isSafeInteger(claimSeq) ||
        claimSeq < 1 ||
        typeof session !== 'string' ||
        !isKeySegment(session)
    ) {
        return bad(reply, ERROR_CODES.BAD_ARTIFACT, 'jobId, claimSeq and session are required');
    }
    const row = r.scope.jobs.find((j) => j.id === jobId);
    if (!row || claimSeq > row.claimSeq) return bad(reply, ERROR_CODES.NOT_FOUND, 'No such transcript', HTTP_NOT_FOUND);
    const ref: StreamRef = {
        member: memberOf(row.member),
        root: r.scope.root,
        job: jobId,
        claimSeq,
        executor: CLAUDE_EXECUTOR,
        session,
        stream: RAW_TRANSCRIPT_STREAM,
    };
    return sendChunk(request, reply, { artifacts: r.artifacts, ref, offset });
}

/** Registers the four restore reads; `jobRoutes` calls it once. */
export function registerRestoreRoutes(app: FastifyInstance, orgs: OrgRegistry) {
    const limit = { bodyLimit: CONTROL_BODY_LIMIT };
    app.post('/api/jobs/:id/checkpoint', limit, (request, reply) => handleCheckpoint(orgs, request, reply));
    app.post('/api/jobs/:id/checkpoint/chunk', limit, (request, reply) => handleCheckpointChunk(orgs, request, reply));
    app.post('/api/jobs/:id/transcripts', limit, (request, reply) => handleTranscripts(orgs, request, reply));
    app.post('/api/jobs/:id/transcripts/chunk', limit, (request, reply) => handleTranscriptChunk(orgs, request, reply));
}
