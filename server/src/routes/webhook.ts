import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { AuthStore } from '../auth/store.js';
import type { OrgRegistry } from '../orgs.js';
import { ERROR_CODES, JSON_CONTENT_TYPE } from '@factory-ai/core';

/**
 * A payload big enough for any member or PR event and far above what a real delivery can reach.
 */
const BODY_LIMIT = 1_000_000;

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;

/**
 * The delivery GUID is the webhook's dedupe key (036) and the column's length bound — a value
 * longer than the column would fail the very insert the route relies on for idempotence.
 */
const DELIVERY_ID_LIMIT = 64;

/**
 * GitHub signs the RAW body with the shared secret and sends `sha256=<hex>` — compare the digests
 * in constant time, the `secretsMatch` shape the auth plugin already uses for its string secrets.
 */
function signatureMatches(secret: string, header: unknown, body: Buffer): boolean {
    if (typeof header !== 'string' || !header.startsWith('sha256=')) return false;
    const expected = Buffer.from(createHmac('sha256', secret).update(body).digest('hex'), 'utf8');
    const provided = Buffer.from(header.slice('sha256='.length), 'utf8');
    if (expected.length !== provided.length) return false;
    return timingSafeEqual(expected, provided);
}

/** The fields this route reads, everything else in the delivery is ignored. */
interface WebhookPayload {
    action?: unknown;
    installation?: { id?: unknown } | null;
    membership?: { user?: { id?: unknown } | null } | null;
    repository?: { full_name?: unknown } | null;
    pull_request?: { number?: unknown; merged?: unknown; head?: { sha?: unknown } | null } | null;
    /** `check_run` and `check_suite` name the PRs they ran for; `status` carries only the commit. */
    check_run?: { head_sha?: unknown; pull_requests?: { number?: unknown }[] | null } | null;
    check_suite?: { head_sha?: unknown; pull_requests?: { number?: unknown }[] | null } | null;
    sha?: unknown;
    /** An issue # addresses a number here too; the PR clincher is `pull_request` on the issue. */
    issue?: { number?: unknown; pull_request?: unknown } | null;
}

/** `'invalid'` rather than throwing: a body GitHub signed that does not parse is a 200, not a fault. */
function parseWebhookPayload(body: Buffer): WebhookPayload | 'invalid' {
    try {
        return JSON.parse(body.toString('utf8')) as WebhookPayload;
    } catch {
        return 'invalid';
    }
}

/**
 * The PR families whose activity wakes a PR wait (036), each action routing to a fold (more
 * activity) or a cancel (the wait's subject is gone). A rule answers null for an action this
 * deployment ignores, always with a 200 — a non-2xx makes GitHub retry a delivery this
 * deployment will never handle.
 */
const PR_FAMILIES: Record<string, (action: unknown) => 'fold' | 'cancel' | null> = {
    pull_request: (action) =>
        action === 'opened' || action === 'synchronize' || action === 'reopened'
            ? 'fold'
            : action === 'closed'
              ? 'cancel'
              : null,
    pull_request_review: (action) => (action === 'submitted' || action === 'dismissed' ? 'fold' : null),
    pull_request_review_comment: (action) => (action === 'created' || action === 'edited' ? 'fold' : null),
    issue_comment: (action) => (action === 'created' || action === 'edited' ? 'fold' : null),
};

/** Unknown events are ignored loudly enough to find in the log, answered 200. */
function resolveDeed(event: unknown, action: unknown): 'fold' | 'cancel' | null {
    const route = typeof event === 'string' ? PR_FAMILIES[event] : undefined;
    return route === undefined ? null : route(action);
}

/**
 * What an event says changed about a batch task's PR, as a refresh hint. Events are hints, never
 * state: the observer re-reads GitHub, so a forged-looking, duplicated or out-of-order delivery can
 * at worst cause a read. Null for an event that cannot move a check or a mergeability.
 */
function observationHint(
    event: unknown,
    payload: WebhookPayload
): { installation: number; repo: string; numbers: number[]; headSha: string | null } | null {
    const installation = payload.installation?.id;
    const repo = payload.repository?.full_name;
    if (typeof installation !== 'number' || typeof repo !== 'string' || repo === '') return null;
    const asNumbers = (values: { number?: unknown }[] | null | undefined): number[] =>
        (values ?? []).map((v) => v.number).filter((n): n is number => typeof n === 'number' && n > 0);
    const sha = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
    switch (event) {
        case 'pull_request':
        case 'pull_request_review':
        case 'pull_request_review_comment': {
            const number = payload.pull_request?.number;
            return {
                installation,
                repo,
                numbers: typeof number === 'number' && number > 0 ? [number] : [],
                headSha: sha(payload.pull_request?.head?.sha),
            };
        }
        case 'check_run':
            return {
                installation,
                repo,
                numbers: asNumbers(payload.check_run?.pull_requests),
                headSha: sha(payload.check_run?.head_sha),
            };
        case 'check_suite':
            return {
                installation,
                repo,
                numbers: asNumbers(payload.check_suite?.pull_requests),
                headSha: sha(payload.check_suite?.head_sha),
            };
        case 'status':
            return { installation, repo, numbers: [], headSha: sha(payload.sha) };
        default:
            return null;
    }
}

/** Asks the org's observer to re-read; a failure is logged and never changes the delivery's answer. */
async function requestObservationRefresh(
    orgs: OrgRegistry,
    event: unknown,
    payload: WebhookPayload,
    log: { warn(message: string): void }
): Promise<void> {
    const hint = observationHint(event, payload);
    if (hint === null) return;
    try {
        const runtime = await orgs.for(String(hint.installation));
        await runtime?.batchObserver?.requestRefresh({
            repo: hint.repo,
            numbers: hint.numbers,
            headSha: hint.headSha,
        });
    } catch (e) {
        log.warn(`batch observation refresh failed: ${(e as Error).message}`);
    }
}

async function handleOrganizationEvent(store: AuthStore, payload: WebhookPayload, reply: FastifyReply): Promise<void> {
    if (payload.action !== 'member_removed') {
        reply.code(HTTP_OK).send({ ok: true });
        return;
    }

    // installation.id IS the organization id — the orgs are the App's installations (#99) — and
    // membership.user.id is THE identity: github_login is a label (docs/auth.md).
    const installation = payload.installation?.id;
    const githubUserId = payload.membership?.user?.id;
    if (typeof installation !== 'number' || typeof githubUserId !== 'number') {
        reply.code(HTTP_OK).send({ ok: true });
        return;
    }

    // The deletion is the whole act of revocation: findSession and findPersonalToken inner-join
    // through org_membership, so the removed account's every credential dies on its next request —
    // bounded by GitHub's report, not the next sign-in.
    await store.removeMember(String(installation), githubUserId);
    reply.code(HTTP_OK).send({ ok: true });
}

interface PrActivity {
    installation: number;
    repo: string;
    number: number;
    deliveryId: string;
}

/** A delivery without a clean installation/repo/number/guid names no wait of ours. */
function parsePrActivity(event: string, payload: WebhookPayload, deliveryIdHeader: unknown): PrActivity | null {
    const installation = payload.installation?.id;
    const repo = payload.repository?.full_name;
    // A fold reached past the family routing, so `event` named a family — a string.
    const number = event === 'issue_comment' ? payload.issue?.number : payload.pull_request?.number;
    const deliveryId = deliveryIdHeader;
    if (
        typeof installation !== 'number' ||
        typeof repo !== 'string' ||
        repo === '' ||
        typeof number !== 'number' ||
        number < 1 ||
        typeof deliveryId !== 'string' ||
        deliveryId === '' ||
        deliveryId.length > DELIVERY_ID_LIMIT
    ) {
        return null;
    }
    return { installation, repo, number, deliveryId };
}

interface PrEventInput {
    event: string;
    deed: 'fold' | 'cancel';
    payload: WebhookPayload;
    deliveryIdHeader: unknown;
}

/**
 * A MERGED close (issue #390) closes the tasks whose recorded publication names this PR, instead
 * of merely cancelling their waits. Strict `=== true`: a missing or non-boolean flag falls
 * through to the ordinary-close path — only a real merge is an automatic Done.
 */
function isMergedClose(event: unknown, payload: WebhookPayload): boolean {
    return event === 'pull_request' && payload.action === 'closed' && payload.pull_request?.merged === true;
}

async function handlePrMerged(
    orgs: OrgRegistry,
    payload: WebhookPayload,
    deliveryIdHeader: unknown,
    reply: FastifyReply
): Promise<void> {
    const activity = parsePrActivity('pull_request', payload, deliveryIdHeader);
    if (!activity) {
        reply.code(HTTP_OK).send({ ok: true });
        return;
    }

    // The org is the installation the delivery addresses, exactly as the fold/cancel path
    // resolves it; a runtime without both stores (an older deployment, or no job store) acks.
    const runtime = await orgs.for(String(activity.installation));
    if (runtime?.prs === undefined || runtime?.jobs === undefined) {
        reply.code(HTTP_OK).send({ ok: true });
        return;
    }

    await runtime.jobs.closeMergedPr(activity.repo, activity.number, activity.deliveryId);
    reply.code(HTTP_OK).send({ ok: true });
}

async function handlePrEvent(orgs: OrgRegistry, input: PrEventInput, reply: FastifyReply): Promise<void> {
    const { event, deed, payload, deliveryIdHeader } = input;
    // An issue comment counts as PR activity only when it sits on a pull request — plain issue
    // chatter is the same no-op as an unrelated event.
    if (event === 'issue_comment' && payload.issue?.pull_request === undefined) {
        reply.code(HTTP_OK).send({ ok: true });
        return;
    }

    const activity = parsePrActivity(event, payload, deliveryIdHeader);
    if (!activity) {
        // A delivery without a clean installation/repo/number/guid names no wait of ours — a
        // 200 no-op, never a store call that could touch the wrong rows.
        reply.code(HTTP_OK).send({ ok: true });
        return;
    }

    // The org is the installation the delivery addresses — another org's runtimes are never
    // consulted, and an org with no PR store (a deployment older than 036) just acks.
    const runtime = await orgs.for(String(activity.installation));
    if (runtime?.prs === undefined) {
        reply.code(HTTP_OK).send({ ok: true });
        return;
    }

    if (deed === 'fold') {
        // The GUID is the dedupe key: a redelivery inserts nothing and folds nothing, so
        // duplicate and out-of-order deliveries never enqueue duplicate work.
        await runtime.prs.recordDelivery({
            deliveryId: activity.deliveryId,
            event,
            action: String(payload.action),
            repo: activity.repo,
            prNumber: activity.number,
        });
    } else {
        await runtime.prs.cancelForRepoPr(activity.repo, activity.number, 'pr closed');
    }
    reply.code(HTTP_OK).send({ ok: true });
}

export const webhookRoutes =
    ({ store, orgs, secret }: { store: AuthStore; orgs: OrgRegistry; secret: string }): FastifyPluginAsync =>
    async (app) => {
        // The signature is computed over the raw bytes, so this scope's parser hands the route the
        // Buffer and verification runs before any parse. Scoped to this plugin: every other route
        // keeps Fastify's own JSON parser.
        app.addContentTypeParser(JSON_CONTENT_TYPE, { parseAs: 'buffer' }, (_request, body, done) => done(null, body));

        app.post('/api/github/webhook', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
            // The signature IS the credential here — the route is open to the auth hook
            // (OPEN_ROUTES) precisely so it can do its own authentication.
            const body = request.body as Buffer;
            if (!signatureMatches(secret, request.headers['x-hub-signature-256'], body)) {
                return reply
                    .code(HTTP_UNAUTHORIZED)
                    .send({ error: 'Invalid signature', code: ERROR_CODES.UNAUTHENTICATED });
            }

            // A body GitHub signed that does not parse is not fixed by a redelivery, so it is
            // 200 and a log line — never a 4xx/5xx for GitHub to retry forever.
            const payload = parseWebhookPayload(body);
            if (payload === 'invalid') {
                request.log.warn('webhook body did not parse');
                return reply.code(HTTP_OK).send({ ok: true });
            }

            const event = request.headers['x-github-event'];

            if (event === 'organization') {
                return handleOrganizationEvent(store, payload, reply);
            }

            // Any delivery that can move a check or a mergeability asks the observer to re-read,
            // whatever else the delivery does below.
            await requestObservationRefresh(orgs, event, payload, request.log);

            // A merged close closes tasks rather than folding waits — decided before the family
            // routing, whose `closed` action would otherwise read as an ordinary cancel.
            if (isMergedClose(event, payload)) {
                return handlePrMerged(orgs, payload, request.headers['x-github-delivery'], reply);
            }

            const deed = resolveDeed(event, payload.action);
            if (deed === null) return reply.code(HTTP_OK).send({ ok: true });

            // A fold reached past the family routing, so `event` named a family — a string.
            return handlePrEvent(
                orgs,
                { event: event as string, deed, payload, deliveryIdHeader: request.headers['x-github-delivery'] },
                reply
            );
        });
    };
