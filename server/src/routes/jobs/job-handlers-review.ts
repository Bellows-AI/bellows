import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ChangeRequestContext } from '../../db/jobs/job-store-change-request.js';
import { sourceOf } from '../../forge/forge-reads.js';
import { type GitlabCall, gitlabRequest } from '../../forge/gitlab-call.js';
import {
    readReviewCollection,
    REVIEW_READ_DEADLINE_MS,
    REVIEW_WRITE_DEADLINE_MS,
    replyReview,
} from '../../forge/gitlab-review.js';
import { PLAN_BYTES_MAX, parseReviewPlan } from '../../forge/review-collection.js';
import { notLive, pairOf, refused, waitAnswer } from '../forge-credential.js';
import { bad } from '../helpers.js';
import {
    type AgentChangeRequestDeps,
    attemptContext,
    starterToken,
    unconfirmed,
} from './job-handlers-change-request.js';
import { closedBy } from './job-handlers-pull-request.js';

/**
 * `GET /api/jobs/:id/agent-review` and `POST /api/jobs/:id/agent-review/replies` (the attempt's pair): the review loop on
 * a GitLab task's recorded merge request (docs/workflows.md). The board reads its discussions and posts, replies and
 * resolves as the thread's STARTER, whose token never leaves the board. Only the recorded request is touched, never a
 * number a caller names. The answers are those of `agent-change-request`: `409 FORGE_GRANT_REQUIRED` (the thread is held,
 * nothing written), `409 CHANGE_REQUEST_READ_UNSUPPORTED` (a GitHub task keeps `gh`), `404 NO_CHANGE_REQUEST`, and
 * `503 UNAVAILABLE` for anything unconfirmed: never an empty collection, never "no comments".
 *
 * The replies route also answers `403` unless the attempt is the review block's own reply step: every runner env carries
 * a live pair, and the repair agent's must not post or resolve outside the digest. The attempt is re-checked before every
 * write and again before the answer goes out.
 */

/** The helper the review block's `reply` node declares as its only step (its id in the block's stored `helperPlans`). */
const REVIEW_REPLY_HELPER_ID = 'review-reply-probe';
const PRE_PHASE = 'pre';
const HTTP_OK = 200;
const HTTP_CONFLICT = 409;
const HTTP_NOT_FOUND = 404;
const BAD_PLAN = 'The body is not a review-reply/v1 plan within its bounds.';
const UNSUPPORTED = 'The board reviews merge requests of GitLab tasks only; a GitHub pull request keeps gh.';
const NONE_RECORDED = "This task's thread has recorded no change request yet.";
/** Fastify's own cap, a margin above the plan bound so an oversize plan is this route's 400, not a 413. */
const BODY_LIMIT_BYTES = PLAN_BYTES_MAX * 2;

export interface AgentReviewDeps extends AgentChangeRequestDeps {
    /** The replies call's wall clock; a test shortens it. `deadlineMs` is the read's. */
    writeDeadlineMs?: number | undefined;
}

const deadlineOf = (ms: number, request: FastifyRequest, reply: FastifyReply) =>
    AbortSignal.any([AbortSignal.timeout(ms), request.closing, closedBy(reply)]);

/** What an attempt acts with: the recorded request and a call made as its starter. */
interface Acting {
    attempt: { orgId: string; claimSeq: number };
    call: GitlabCall;
    ref: NonNullable<ChangeRequestContext['ref']>;
    number: number;
}

/**
 * The call to make as the starter for the attempt's recorded request, or null once the refusal is sent. `allowed` lets a
 * route refuse an attempt that is live but not its own step, before the token is read.
 */
async function actingAs(
    deps: AgentReviewDeps,
    reply: FastifyReply,
    ask: {
        pair: { jobId: string; leaseToken: string };
        signal: AbortSignal;
        allowed?: (who: ChangeRequestContext) => boolean;
    }
): Promise<Acting | null> {
    const { pair, signal, allowed = () => true } = ask;
    const found = await attemptContext(deps, reply, pair);
    if (!found) return null;
    const { attempt, who } = found;
    if (!allowed(who)) {
        void refused(reply);
        return null;
    }
    const starter = await starterToken(deps, who, signal);
    if (starter.kind === 'grant') {
        const { forge, reason } = starter;
        await waitAnswer(deps, reply, { attempt, leaseToken: pair.leaseToken, forge, reason });
        return null;
    }
    if (starter.kind === 'none') {
        void bad(reply, ERROR_CODES.NO_CHANGE_REQUEST, NONE_RECORDED, HTTP_NOT_FOUND);
        return null;
    }
    if (starter.kind === 'unsupported') {
        void bad(reply, ERROR_CODES.CHANGE_REQUEST_READ_UNSUPPORTED, UNSUPPORTED, HTTP_CONFLICT);
        return null;
    }
    const source = await sourceOf({ forge: {}, gitlab: deps.gitlab }, who.orgId, starter.ref, signal);
    if (source.gitlab === undefined) throw new Error('no GitLab access answers for the repository');
    const call = gitlabRequest(source.gitlab, starter.ref, starter.token);
    return { attempt, call, ref: starter.ref, number: starter.number };
}

/** Whether the pair is still the attempt that began the call: a cancel, settle or takeover since is not. */
const stillTheSame = async (
    deps: AgentReviewDeps,
    pair: { jobId: string; leaseToken: string },
    acting: Acting
): Promise<boolean> => {
    const now = await deps.attemptOfLease(pair.jobId, pair.leaseToken);
    return now.ok && now.orgId === acting.attempt.orgId && now.claimSeq === acting.attempt.claimSeq;
};

/** Sends why the attempt is no longer live: pending takeover or terminal. Only after `stillTheSame` said no. */
async function withheld(deps: AgentReviewDeps, reply: FastifyReply, pair: { jobId: string; leaseToken: string }) {
    const now = await deps.attemptOfLease(pair.jobId, pair.leaseToken);
    return now.ok ? refused(reply) : notLive(reply, now);
}

const collectHandler = (deps: AgentReviewDeps) => async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('cache-control', 'no-store');
    const pair = pairOf(request);
    if (pair === null) return refused(reply);
    try {
        const signal = deadlineOf(deps.deadlineMs ?? REVIEW_READ_DEADLINE_MS, request, reply);
        const acting = await actingAs(deps, reply, { pair, signal });
        if (!acting) return reply;
        const collection = await readReviewCollection(acting.call, acting.ref, acting.number, signal);
        // The read took time: a cancel, settle or takeover during it withholds the answer.
        if (!(await stillTheSame(deps, pair, acting))) return await withheld(deps, reply, pair);
        return reply.code(HTTP_OK).send(collection);
    } catch (e) {
        return unconfirmed(request, reply, pair.jobId, e);
    }
};

const isReplyStep = (who: ChangeRequestContext): boolean =>
    who.helperPlans.some((plan) => plan.helperId === REVIEW_REPLY_HELPER_ID && plan.phase === PRE_PHASE);

const repliesHandler = (deps: AgentReviewDeps) => async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('cache-control', 'no-store');
    const pair = pairOf(request);
    if (pair === null) return refused(reply);
    const plan = parseReviewPlan(request.body);
    if (plan === null || Buffer.byteLength(JSON.stringify(request.body), 'utf8') > PLAN_BYTES_MAX) {
        return bad(reply, ERROR_CODES.BAD_BODY, BAD_PLAN);
    }
    try {
        const signal = deadlineOf(deps.writeDeadlineMs ?? REVIEW_WRITE_DEADLINE_MS, request, reply);
        const acting = await actingAs(deps, reply, { pair, signal, allowed: isReplyStep });
        if (!acting) return reply;
        const live = () => stillTheSame(deps, pair, acting);
        const result = await replyReview(acting.call, { ref: acting.ref, iid: acting.number }, plan, { signal, live });
        if (!(await live())) return await withheld(deps, reply, pair);
        return reply.code(HTTP_OK).send(result);
    } catch (e) {
        return unconfirmed(request, reply, pair.jobId, e);
    }
};

export const agentReviewRoutes =
    (deps: AgentReviewDeps): FastifyPluginAsync =>
    async (app) => {
        app.get('/api/jobs/:id/agent-review', collectHandler(deps));
        app.post('/api/jobs/:id/agent-review/replies', { bodyLimit: BODY_LIMIT_BYTES }, repliesHandler(deps));
    };
