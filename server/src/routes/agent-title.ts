import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { AgentTitle, AgentTitleResult } from '../db/agent-title.js';
import type { AttemptOfLease } from '../db/attempt-of-lease.js';
import { bad, body, leasePending } from './helpers.js';
import { pairOrRefuse } from './operation-receipts.js';
import { validateTitleField } from './jobs/job-field-validation.js';

/**
 * `POST /api/jobs/:id/agent-title` (docs/connections.md): the running agent names its own task. The
 * attempt pair is the only credential (`CONNECTOR_ROUTES` in auth/plugin.ts); the write re-checks that pair
 * under its locks (`db/agent-title.ts`). A throwing check or store is 503 retryable, never a refusal and never
 * "unchanged". Nothing here carries a credential.
 */
export interface AgentTitleRoutesDeps {
    attemptOfLease: AttemptOfLease;
    agentTitle: AgentTitle;
}

const HTTP_FORBIDDEN = 403;
const HTTP_TOO_MANY = 429;
const HTTP_UNAVAILABLE = 503;
const BODY_LIMIT = 4096;
const REFUSED = 'This attempt may not set the title: it is no longer running. Do not retry.';
const UNREADABLE = 'The title could not be written just now. Retry shortly.';
const LIMIT = 'This attempt already changed the title as often as it may. Do not retry.';

const unavailable = (reply: FastifyReply) =>
    reply
        .code(HTTP_UNAVAILABLE)
        .header('retry-after', '1')
        .send({ error: UNREADABLE, code: ERROR_CODES.UNAVAILABLE, retryable: true });

const refused = (reply: FastifyReply) =>
    reply.code(HTTP_FORBIDDEN).send({ error: REFUSED, code: ERROR_CODES.CONNECTION_NOT_AUTHORIZED });

/** The reply to a store answer: 200 with the board's words, or the refusal's status. */
function answerOf(reply: FastifyReply, written: AgentTitleResult) {
    if (written.ok) {
        const { ok: _ok, ...answer } = written;
        return reply.send(answer);
    }
    if (written.refusal === 'pending') return leasePending(reply);
    if (written.refusal === 'limit') return bad(reply, ERROR_CODES.TITLE_LIMIT, LIMIT, HTTP_TOO_MANY);
    return refused(reply);
}

/** The one title in a `{title}` body, normalized; null for anything else. */
function titleOf(raw: unknown): { title: string } | { message: string } {
    const fields = body(raw);
    if (Object.keys(fields).some((key) => key !== 'title')) return { message: 'only title is accepted' };
    const parsed = validateTitleField(fields.title);
    if (!parsed.ok) return { message: parsed.message };
    return parsed.value === null ? { message: 'title is required' } : { title: parsed.value };
}

export function agentTitleRoutes({ attemptOfLease, agentTitle }: AgentTitleRoutesDeps): FastifyPluginAsync {
    /** The pair's attempt, then the write under it; a refusal or pending attempt is the reply. */
    const write = async (reply: FastifyReply, pair: { jobId: string; leaseToken: string }, title: string) => {
        const attempt = await attemptOfLease(pair.jobId, pair.leaseToken);
        if (!attempt.ok) return attempt.pending ? leasePending(reply) : refused(reply);
        const { orgId, rootJobId } = attempt;
        return answerOf(
            reply,
            await agentTitle({ orgId, jobId: pair.jobId, rootJobId, leaseToken: pair.leaseToken, title })
        );
    };
    return async (app) => {
        app.post('/api/jobs/:id/agent-title', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
            const pair = pairOrRefuse(request, reply);
            if ('statusCode' in pair) return pair;
            const parsed = titleOf(request.body);
            if ('message' in parsed) return bad(reply, ERROR_CODES.BAD_TITLE, parsed.message);
            try {
                return await write(reply, pair, parsed.title);
            } catch {
                // Not logged beyond the job id: the thrown text may carry a store's words.
                request.log.warn({ jobId: pair.jobId }, 'agent title write failed');
                return unavailable(reply);
            }
        });
    };
}
