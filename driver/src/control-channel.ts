import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, respondJson } from './http.js';
import { PUBLISH_BODY_LIMIT, type PublishRelay, servePublish } from './publish-control.js';
import { type ExportRelay, type ExportSlot, EXPORT_PATH, serveExport } from './export-control.js';
import { createStepBroker, serveReport, serveStepPoll, serveStepResult, type StepBroker } from './step-control.js';
import { REPORT_PATH, STEP_PATH } from './supervisor-contract.js';
import { REVIEW_BODY_LIMIT, type ReviewRelay, serveReviewRead, serveReviewRequest } from './review-control.js';
import {
    cancelPendingQuestions,
    type ControlEntry,
    hasPendingQuestion,
    newControl,
    QUESTION_BODY_LIMIT,
    type QuestionRelay,
    type QuestionResolution,
    readQuestion,
    recordQuestion,
    resolveQuestion,
} from './question-control.js';

/**
 * The per-attempt run-control channel the gate server hosts beside the ad-hoc gate route, keyed by
 * three tokens of one lease that open different doors:
 *
 *  - the SUPERVISOR token — held by the task supervisor alone — reads the run's stop and kill orders
 *    (`GET /control`), relays the agent's questions (`POST /question`, `GET /question/:id`) and pulls
 *    and answers the supervised steps (`/step`, `POST /report`);
 *  - the EXPORTER token — all the transcript exporter holds — carries the transcript chunks
 *    (`/export`) and nothing else;
 *  - the AGENT token — all the agent container holds — reaches only the draft publication
 *    (`POST /publish`) and the named reviewers (`/review`), the two routes the baked skills call.
 *
 * A token used on another's route is 403; a gate token is no key here, and an unknown or closed
 * token is 401. One entry per attempt, so one per lease.
 */

/** The run-control poll route the task supervisor reads (`scripts/supervisor.cjs`). */
export const CONTROL_PATH = '/control';
/** The draft-publication route beside it: `POST /publish`. */
export const PUBLISH_PATH = '/publish';
/** The question routes beside it: `POST /question`, `GET /question/:questionId`. */
export const QUESTION_PATH = '/question';
/** The reviewer routes beside them (issue #549): `POST /review`, `GET /review/:key`. */
export const REVIEW_PATH = '/review';

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_PAYLOAD_TOO_LARGE = 413;

export interface ControlChannel {
    /**
     * Opens the supervisor token (idempotent); `relay` carries its questions to the board,
     * `publisher` the agent's draft publishes and `reviewer` its named-reviewer requests (none on a
     * run that may not invoke one).
     */
    open(token: string, relay?: QuestionRelay, publisher?: PublishRelay, reviewer?: ReviewRelay): void;
    /** Opens the agent's own token beside the open supervisor `token`: the publish and review routes, no other. */
    grantAgent(token: string, agentToken: string): void;
    /**
     * Opens the transcript exporter's own token beside the open supervisor `token`: the export routes, no
     * other. With `exporter` the token is bound to that relay instead of the attempt's own — a review's
     * close-time export (issue #774) rides the caller's group under the review row's identity.
     */
    grantExporter(token: string, exporterToken: string, exporter?: ExportRelay): void;
    /** Closes a bound exporter token once its step is over; the attempt's own tokens are not touched. */
    revokeExporter(exporterToken: string): void;
    /** Gives an open token its transcript exporter's relay: the `/export` routes answer 400 until then. */
    attachExporter(token: string, exporter: ExportRelay): void;
    /** Whether the supervisor has contacted this token — its control poll, or a question POST. */
    polled(token: string): boolean;
    /** Raises the stop; repeated calls and unknown tokens do nothing. */
    raiseStop(token: string): void;
    /** Raises the kill order — the stop, and the supervisor ends the agent now; repeated calls do nothing. */
    raiseKill(token: string): void;
    /** Ends the attempt: its stop flag and its questions are dropped, and every token of it gets 401. */
    close(token: string): void;
    /**
     * Leaves the attempt to a newer holder (#829): like `close`, but every token of it — the supervisor's, the
     * agent's, the exporter's — is hung up on for `forMs` instead of answered 401, which a live supervisor
     * reads as the end of its attempt. Past the bound the tokens are unknown, as any closed token is.
     */
    depart(token: string, forMs: number): void;
    /** Drops every token — the server is closing. */
    clear(): void;
    /** Settles a pending question; false and no change for an unknown token or id or a settled question. */
    resolveQuestion(token: string, questionId: string, resolution: QuestionResolution): boolean;
    /** Whether a question is pending on the token — the wait a Stop must drain rather than kill. */
    hasPendingQuestion(token: string): boolean;
    /** Turns every pending question of the token into `cancelled`. */
    cancelQuestions(token: string): void;
    /** Serves a control or question request; false when the request is neither. */
    serve(request: IncomingMessage, reply: ServerResponse, auth: string): Promise<boolean>;
}

type Route = 'control' | 'export' | 'publish' | 'question' | 'report' | 'review' | 'step';

/** A path that is a POST of its own, or a GET of `<path>/<id>`: the shape the question and review routes share. */
const isPostOrGetOf = (request: IncomingMessage, path: string): boolean => {
    const url = request.url ?? '';
    return url === path ? request.method === 'POST' : request.method === 'GET' && url.startsWith(`${path}/`);
};

/** The supervised steps' routes (`GET /step`, `POST /step/:id`, `POST /report`), or null for any other request. */
function stepRouteOf(request: IncomingMessage, url: string): 'step' | 'report' | null {
    if (request.method === 'POST') {
        if (url === REPORT_PATH) return 'report';
        return url.startsWith(`${STEP_PATH}/`) ? 'step' : null;
    }
    return request.method === 'GET' && (url === STEP_PATH || url.startsWith(`${STEP_PATH}?`)) ? 'step' : null;
}

/** Which control route a request is, or null when it is none of them. */
function routeOf(request: IncomingMessage): Route | null {
    const url = request.url ?? '';
    if (request.method === 'GET' && url === CONTROL_PATH) return 'control';
    if (url === EXPORT_PATH || url.startsWith(`${EXPORT_PATH}/`)) return 'export';
    if (request.method === 'POST' && url === PUBLISH_PATH) return 'publish';
    if (isPostOrGetOf(request, QUESTION_PATH)) return 'question';
    const stepRoute = stepRouteOf(request, url);
    if (stepRoute) return stepRoute;
    return isPostOrGetOf(request, REVIEW_PATH) ? 'review' : null;
}

/** The routes each token opens: the supervisor's, the exporter's one and the agent's two. */
const SUPERVISOR_ROUTES: readonly Route[] = ['control', 'question', 'report', 'step'];
const EXPORTER_ROUTES: readonly Route[] = ['export'];
const AGENT_ROUTES: readonly Route[] = ['publish', 'review'];

/** `GET /step`, `POST /step/:id` and `POST /report`: the supervised steps' routes, under the supervisor token. */
function serveSupervisorStep(
    route: 'step' | 'report',
    channel: { steps: StepBroker; token: string },
    request: IncomingMessage,
    reply: ServerResponse
) {
    const { steps, token } = channel;
    if (route === 'report') return serveReport(steps, token, request);
    if (request.method === 'POST') return serveStepResult(steps, token, request);
    // A long poll the supervisor may hang up on (its own timeout, its container ending): the wait ends with it.
    const hangup = new AbortController();
    reply.on('close', () => {
        if (!reply.writableFinished) hangup.abort();
    });
    return serveStepPoll(steps, token, request, hangup.signal);
}

/** `GET /control`'s answer: the stop and kill orders, and the gate steps the driver cancelled when there are any. */
function controlAnswer(steps: StepBroker, token: string, orders: { stop: boolean; kill: boolean }) {
    const cancel = steps.cancels(token);
    return cancel.length > 0 ? { ...orders, cancel } : orders;
}

/**
 * A token with no control entry: refused, unless it is a supervisor-only token (a reclaim's group,
 * no attempt) open on the step broker alone — it polls its orders and answers its steps, and has
 * no stop to read.
 */
async function serveWithoutEntry(
    route: Route,
    channel: { steps: StepBroker; token: string },
    request: IncomingMessage,
    reply: ServerResponse
): Promise<void> {
    if (!channel.steps.has(channel.token) || !(route === 'step' || route === 'report' || route === 'control')) {
        respondJson(reply, HTTP_UNAUTHORIZED, { error: 'unknown token' });
    } else if (route === 'control') {
        respondJson(reply, HTTP_OK, controlAnswer(channel.steps, channel.token, { stop: false, kill: false }));
    } else {
        const answer = await serveSupervisorStep(route, channel, request, reply);
        respondJson(reply, answer.status, answer.body);
    }
}

/** What a route answers: its status and JSON body. */
interface BodyAnswer {
    status: number;
    body: unknown;
}

/** A route that reads a bounded body: 413 past the bound, `stale` once the attempt closed meanwhile, else its answer. */
async function afterBody(
    request: IncomingMessage,
    limit: number,
    stale: () => BodyAnswer | null,
    answer: (raw: string) => BodyAnswer | Promise<BodyAnswer>
): Promise<BodyAnswer> {
    const raw = await readBody(request, limit);
    if (raw === null) return { status: HTTP_PAYLOAD_TOO_LARGE, body: { error: 'body too large' } };
    return stale() ?? answer(raw);
}

type Stale = () => BodyAnswer | null;

/** `POST /question` / `GET /question/:id`, once the token is known. */
const serveQuestion = (control: ControlEntry, request: IncomingMessage, stale: Stale) =>
    request.method === 'GET'
        ? readQuestion(control, (request.url ?? '').slice(QUESTION_PATH.length + 1))
        : afterBody(request, QUESTION_BODY_LIMIT, stale, (raw) => recordQuestion(control, raw));

/** `POST /publish`: the body names nothing and is only drained, bounded. */
const serveDraftPublish = (control: ControlEntry, request: IncomingMessage, stale: Stale) =>
    afterBody(request, PUBLISH_BODY_LIMIT, stale, () => servePublish(control.publishing, control.publisher));

/** `POST /review` / `GET /review/:key`, once the token is known. */
const serveReview = (control: ControlEntry, request: IncomingMessage, stale: Stale) =>
    request.method === 'GET'
        ? serveReviewRead(control.reviewer, (request.url ?? '').slice(REVIEW_PATH.length + 1))
        : afterBody(request, REVIEW_BODY_LIMIT, stale, (raw) =>
              serveReviewRequest(control.reviewing, control.reviewer, raw)
          );

/** The tokens of attempts left to a newer holder (#829): remembered, to be hung up on, until their bound passes. */
function createDepartures() {
    const timers = new Map<string, NodeJS.Timeout>();
    return {
        has: (token: string): boolean => timers.has(token),
        add(tokens: string[], forMs: number): void {
            const forget = setTimeout(() => {
                for (const each of tokens) timers.delete(each);
            }, forMs);
            forget.unref();
            for (const each of tokens) {
                clearTimeout(timers.get(each));
                timers.set(each, forget);
            }
        },
        clear(): void {
            for (const timer of timers.values()) clearTimeout(timer);
            timers.clear();
        },
    };
}

export function createControlChannel(steps: StepBroker = createStepBroker()): ControlChannel {
    /** Every attempt, under its supervisor token. */
    const controls = new Map<string, ControlEntry>();
    /** An agent token, to the supervisor token of the attempt it belongs to. */
    const agents = new Map<string, string>();
    /** A transcript exporter's token, to the attempt it belongs to and, for a review's, the relay of its own. */
    const exporters = new Map<string, { owner: string; slot?: ExportSlot }>();
    const departed = createDepartures();

    const close = (token: string) => {
        controls.delete(token);
        steps.close(token);
        for (const [agent, owner] of agents) if (owner === token) agents.delete(agent);
        for (const [exporter, { owner }] of exporters) if (owner === token) exporters.delete(exporter);
    };

    /** A closed attempt's answer: 401, unless it departed, which no answer at all stands for. */
    const gone = (request: IncomingMessage, auth: string) => {
        if (departed.has(auth)) request.socket.destroy();
        return { status: HTTP_UNAUTHORIZED, body: { error: 'unknown token' } };
    };

    /** The attempt a token of any role belongs to, or undefined once it is closed. */
    const entryOf = (auth: string): ControlEntry | undefined =>
        controls.get(auth) ?? controls.get(agents.get(auth) ?? exporters.get(auth)?.owner ?? '');

    /** The doors a token of a known attempt opens. */
    const doorsOf = (auth: string): readonly Route[] => {
        if (controls.has(auth)) return SUPERVISOR_ROUTES;
        return exporters.has(auth) ? EXPORTER_ROUTES : AGENT_ROUTES;
    };

    return {
        open(token, relay, publisher, reviewer) {
            if (!controls.has(token)) {
                controls.set(token, newControl(relay ?? null, publisher ?? null, reviewer ?? null));
                steps.open(token);
            }
        },
        grantAgent(token, agentToken) {
            if (agentToken !== token) agents.set(agentToken, token);
        },
        grantExporter(token, exporterToken, exporter) {
            if (exporterToken === token) return;
            exporters.set(exporterToken, exporter ? { owner: token, slot: { relay: exporter } } : { owner: token });
        },
        revokeExporter: (exporterToken) => void exporters.delete(exporterToken),
        attachExporter(token, exporter) {
            const control = controls.get(token);
            if (control) control.exporting.relay = exporter;
        },
        polled: (token) => controls.get(token)?.polled ?? false,
        raiseStop(token) {
            const control = controls.get(token);
            if (control) control.stop = true;
        },
        raiseKill(token) {
            const control = controls.get(token);
            if (!control) return;
            control.stop = true;
            control.kill = true;
        },
        close,
        depart(token, forMs) {
            const tokens = [token];
            for (const [agent, owner] of agents) if (owner === token) tokens.push(agent);
            for (const [exporter, { owner }] of exporters) if (owner === token) tokens.push(exporter);
            close(token);
            departed.add(tokens, forMs);
        },
        clear() {
            departed.clear();
            for (const token of controls.keys()) steps.close(token);
            controls.clear();
            agents.clear();
            exporters.clear();
        },
        resolveQuestion: (token, id, resolution) => {
            const control = controls.get(token);
            return control ? resolveQuestion(control, id, resolution) : false;
        },
        hasPendingQuestion: (token) => {
            const control = controls.get(token);
            return control ? hasPendingQuestion(control) : false;
        },
        cancelQuestions(token) {
            const control = controls.get(token);
            if (control) cancelPendingQuestions(control);
        },
        async serve(request, reply, auth) {
            if (departed.has(auth)) {
                request.socket.destroy();
                return true;
            }
            const route = routeOf(request);
            if (route === null) return false;
            const control = entryOf(auth);
            if (!control) {
                await serveWithoutEntry(route, { steps, token: auth }, request, reply);
                return true;
            }
            const doors = doorsOf(auth);
            if (!doors.includes(route)) {
                respondJson(reply, HTTP_FORBIDDEN, { error: 'this token does not open that route' });
                return true;
            }
            if (route === 'export') {
                // Not the supervisor: the exporter's calls never say a supervisor is listening.
                const slot = exporters.get(auth)?.slot ?? control.exporting;
                const answer = await serveExport(slot, request, () => entryOf(auth) === control);
                respondJson(reply, answer.status, answer.body);
                return true;
            }
            // Only the supervisor holds a door that gets here besides publish and review: its poll
            // or its question is what says a Stop can be cooperative.
            if (doors === SUPERVISOR_ROUTES) control.polled = true;
            if (route === 'control') {
                respondJson(reply, HTTP_OK, controlAnswer(steps, auth, { stop: control.stop, kill: control.kill }));
                return true;
            }
            const serveStep = async () =>
                serveSupervisorStep(route === 'report' ? 'report' : 'step', { steps, token: auth }, request, reply);
            const serveRoute = {
                publish: serveDraftPublish,
                review: serveReview,
                question: serveQuestion,
                step: serveStep,
                report: serveStep,
            }[route];
            // Closed while a body arrived: the entry read before is the dead attempt's.
            const stale = (): BodyAnswer | null => (entryOf(auth) === control ? null : gone(request, auth));
            const answer = await serveRoute(control, request, stale);
            respondJson(reply, answer.status, answer.body);
            return true;
        },
    };
}
