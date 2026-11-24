import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { UUID } from '../../identifiers.js';
import {
    ArtifactIntegrityError,
    ArtifactObjectMissingError,
    GATE_STREAM_PREFIX,
} from '../../artifacts/artifact-store.js';
import type { StreamRef } from '../../artifacts/keys.js';
import type { OrgRegistry } from '../../orgs.js';
import { bad, guard } from '../helpers.js';
import { resolve, type Resolved } from './job-handlers-restore.js';
import { CONTROL_BODY_LIMIT, HTTP_NOT_FOUND, HTTP_OK, HTTP_UNAVAILABLE } from './job-limits.js';

/**
 * `POST /api/jobs/:id/gate-log` — one gate run's whole output, the stream the driver stored when the run ended
 * (`gate-<name>-<execution id>`, `driver/src/artifact-upload.ts`), looked up by execution id across the rows of
 * the caller's own thread under the caller's live lease. What `factory-gate <name> --last --full` reads: the
 * stored gate report keeps an excerpt, this keeps the log. A run with no stream answers 404; one whose manifest is missing answers a retryable 503, and one finalized short of `complete` answers its bytes with `truncated` and the manifest's `cause`.
 */

const HTTP_UNPROCESSABLE = 422;

/** The run's stream among the thread's rows: the one named `gate-…-<execution id>`, or null. */
async function findStream(r: Resolved, executionId: string): Promise<StreamRef | null> {
    const suffix = `-${executionId}`;
    for (const row of r.scope.jobs) {
        for (const s of await r.artifacts.streamsOfJob(row.id)) {
            if (s.stream.startsWith(GATE_STREAM_PREFIX) && s.stream.endsWith(suffix)) {
                const { member, root, job, claimSeq, executor, session, stream } = s;
                return { member, root, job, claimSeq, executor, session, stream };
            }
        }
    }
    return null;
}

/** The stream's text, chunk by chunk in offset order, and what its manifest says about how whole it is. */
async function readStream(
    r: Resolved,
    ref: StreamRef
): Promise<{ text: string; truncated: boolean; cause: string | null } | typeof UNFINALIZED> {
    // The manifest first: a stream no manifest closed is still uploading, or its upload died — either way its
    // chunks are a prefix of unknown length, and a read that cannot tell is not an answer.
    const manifest = await r.artifacts.readManifest(ref);
    if (!manifest) return UNFINALIZED;
    const parts: Uint8Array[] = [];
    for (const { offset } of await r.artifacts.listChunks(ref)) {
        const chunk = await r.artifacts.readChunk(ref, offset);
        if (!chunk) throw new ArtifactObjectMissingError('a chunk of the gate log is gone');
        parts.push(chunk.body);
    }
    // Every finalization short of `complete` — the driver's cut head, a failed upload, the board's caps — is said.
    return {
        text: Buffer.concat(parts).toString('utf8'),
        truncated: manifest.state !== 'complete',
        cause: manifest.terminalCause,
    };
}

const UNFINALIZED = Symbol('unfinalized');
const MISSING = Symbol('missing');
const CORRUPT = Symbol('corrupt');

export async function handleGateLog(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const r = await resolve(orgs, request, reply);
    if (!r) return reply;
    const { executionId } = r.body;
    if (typeof executionId !== 'string' || !UUID.test(executionId)) {
        return bad(reply, ERROR_CODES.BAD_ARTIFACT, 'executionId is required');
    }
    const read = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'gate log read failed'),
        async () => {
            const ref = await findStream(r, executionId);
            if (!ref) return MISSING;
            try {
                return await readStream(r, ref);
            } catch (e) {
                if (e instanceof ArtifactObjectMissingError) return MISSING;
                // Stored bytes that fail their recorded digest are corrupt for good, not a store outage to retry.
                if (e instanceof ArtifactIntegrityError) return CORRUPT;
                throw e;
            }
        }
    );
    if (!read.ok) return reply;
    if (read.value === CORRUPT) {
        return bad(
            reply,
            ERROR_CODES.ARTIFACT_CORRUPT,
            'The stored gate log fails its recorded sha256',
            HTTP_UNPROCESSABLE
        );
    }
    if (read.value === UNFINALIZED) {
        return bad(
            reply,
            ERROR_CODES.ARTIFACTS_UNAVAILABLE,
            'The gate log is not finalized yet; retry shortly',
            HTTP_UNAVAILABLE
        );
    }
    if (read.value === MISSING) return bad(reply, ERROR_CODES.NOT_FOUND, 'No such gate log', HTTP_NOT_FOUND);
    return reply.code(HTTP_OK).send(read.value);
}

/** Registers the gate-log read; `jobRoutes` calls it once. */
export function registerGateLogRoute(app: FastifyInstance, orgs: OrgRegistry) {
    app.post('/api/jobs/:id/gate-log', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
        handleGateLog(orgs, request, reply)
    );
}
