import type { IncomingMessage } from 'node:http';
import { readBody } from './http.js';
import { parseJsonObject } from './json-parse.js';
import {
    STEP_ANSWER_GRACE_MS,
    STEP_OUTPUT_LIMIT_BYTES,
    STEP_PATH,
    type StepRequest,
    type StepResult,
    type SupervisorReport,
} from './supervisor-contract.js';

/**
 * The supervised-step channel (issue #771), one per control token — so one lease. The loop and the
 * runners SUBMIT a step (`submit`); the task supervisor, the only holder of the control token,
 * PULLS it (`GET /step`, a long poll) and answers it (`POST /step/:id`). A step is never a container
 * or a Job: it is a request the supervisor runs in its own container over the task volume.
 *
 * The broker keeps four promises the callers lean on:
 *  - a step is an effect (`id`) asked by one call (`invocation`): submitting a call that is in
 *    flight joins it, and a new call is queued afresh — whether it runs or answers from the
 *    supervisor's ledger is the supervisor's to decide, never a cached answer here;
 *  - a closed token rejects every waiter (`StepChannelClosed`) — a finished attempt leaves no step
 *    queued for a supervisor that will never come;
 *  - a group with nobody left to answer — its supervisor reported it is leaving, or the runner saw
 *    the group end or took it away (`release`) — rejects every waiter at once, and every later step,
 *    until a runner makes a group under the token again (`attach`);
 *  - the supervisor's one report (the agent is over and the exporter drained) is read, not polled,
 *    and taken once by its id however often it is redelivered.
 */

/** Thrown to a waiter when its attempt's control token closes before the answer arrives. */
export class StepChannelClosed extends Error {
    constructor(what: string) {
        super(`the task supervisor channel closed before ${what}`);
        this.name = 'StepChannelClosed';
    }
}

/**
 * Thrown to a waiter whose step was not answered in its own timeout plus the grace: the answer is
 * LOST, not negative — the step may have run. A retry under the same id is answered from the
 * supervisor's ledger when it did.
 */
export class StepTimedOut extends Error {
    constructor(id: string) {
        super(`step ${id} was not answered in time`);
        this.name = 'StepTimedOut';
    }
}

/**
 * Whether a step failed because its supervisor was lost — the channel closed, or the answer never
 * came — which is no verdict on the step itself: the attempt was interrupted (issue #826).
 */
export const stepLost = (error: unknown): boolean =>
    error instanceof StepChannelClosed || error instanceof StepTimedOut;

/** What the runners and the loop use: submit a step, read the supervisor's report. */
export interface StepSink {
    /** Runs one step in the attempt's supervisor and answers its result; rejects when the channel is closed or `signal` aborts. */
    submit(token: string, step: StepRequest, signal?: AbortSignal): Promise<StepResult>;
    /** Resolves once the supervisor reports the agent over and its exporter drained; rejects when the channel closes first. */
    awaitReport(token: string, signal?: AbortSignal): Promise<SupervisorReport>;
    /** Whether the supervisor has ever pulled a step or posted a report on this token. */
    contacted(token: string): boolean;
    /** The group serving the token ended or was taken away: every waiting and later step is refused. */
    release(token: string): void;
    /** A runner makes a group under the token: a fresh supervisor, with no contact, report or refusal yet. */
    attach(token: string): void;
}

/**
 * How a runner reaches a supervisor of its own making: a group with no attempt (a terminal
 * reclaim) has no run-control token from the loop, so the runner opens one — a step channel and
 * nothing else — and the endpoint it is served on.
 */
export interface SupervisorEndpoint {
    /** Opens a fresh supervisor-only token and answers it with the endpoint's advertised URL. */
    open(): Promise<{ url: string; token: string }>;
    close(token: string): void;
}

export interface StepBroker extends StepSink {
    open(token: string): void;
    close(token: string): void;
    /** Whether the token is open: a supervisor-only token has no control entry, and this is its authorization. */
    has(token: string): boolean;
    /** The next queued step, `null` after `waitMs` with none, or `'closed'` for an unknown or closed token. */
    next(token: string, waitMs: number, signal: AbortSignal): Promise<StepRequest | null | 'closed'>;
    /** Records one call's result; false for an unknown token or a call nobody waits for. */
    settle(token: string, id: string, invocation: string, result: StepResult): boolean;
    /**
     * Takes the supervisor's report: `accepted` the first time, or a serving report's departure under
     * the same id; `duplicate` for a redelivery; `conflict` for another report than the one taken.
     */
    report(token: string, report: SupervisorReport): 'accepted' | 'duplicate' | 'conflict';
}

interface Waiter {
    resolve: (result: StepResult) => void;
    reject: (error: Error) => void;
    promise: Promise<StepResult>;
}

interface Poller {
    resolve: (step: StepRequest | null) => void;
}

interface Slot {
    queue: StepRequest[];
    /** By call: `callKey(id, invocation)`. */
    waiters: Map<string, Waiter>;
    pollers: Poller[];
    contacted: boolean;
    reported: SupervisorReport | null;
    reportWaiters: { resolve: (report: SupervisorReport) => void; reject: (error: Error) => void }[];
    /** Why nobody is left to answer a step on this token, or null while a supervisor serves it. */
    gone: string | null;
    /** The reports of groups a runner made again since: a late delivery of one is never the new group's. */
    retired: Set<string>;
}

const newSlot = (): Slot => ({
    queue: [],
    waiters: new Map(),
    pollers: [],
    contacted: false,
    reported: null,
    reportWaiters: [],
    gone: null,
    retired: new Set(),
});

const callKey = (id: string, invocation: string): string => `${id}\n${invocation}`;

/** Nobody is left to answer a step on this slot: its waiters, its queue and its polls are let go at once. */
function abandon(slot: Slot, why: string): void {
    slot.gone = why;
    slot.queue.length = 0;
    const waiters = [...slot.waiters.values()];
    slot.waiters.clear();
    for (const waiter of waiters) waiter.reject(new StepChannelClosed(`its step was answered: ${why}`));
    for (const poller of [...slot.pollers]) poller.resolve(null);
}

/** The report waiters of a group that is gone: its report will never come. */
function dropReportWaiters(slot: Slot): void {
    for (const waiter of slot.reportWaiters.splice(0)) waiter.reject(new StepChannelClosed('the supervisor reported'));
}

/** Takes one delivery of the supervisor's report into its slot (`StepBroker.report`). */
function takeReport(slot: Slot, report: SupervisorReport): 'accepted' | 'duplicate' | 'conflict' {
    if (slot.retired.has(report.id)) return 'conflict';
    slot.contacted = true;
    const taken = slot.reported;
    if (taken && taken.id !== report.id) return 'conflict';
    // Only the departure moves a taken report: `serving` never turns true again.
    if (taken && (report.serving || !taken.serving)) return 'duplicate';
    const accepted = taken ? { ...taken, serving: false } : report;
    slot.reported = accepted;
    for (const waiter of slot.reportWaiters.splice(0)) waiter.resolve(accepted);
    if (!accepted.serving) abandon(slot, 'the supervisor finalized the attempt and left');
    return 'accepted';
}

/** A signal-bound wait: rejects with the signal's reason once it aborts, and never leaks the listener. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined, what: string): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(new Error(`${what} was cancelled`));
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(new Error(`${what} was cancelled`));
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            (value) => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            },
            (error: Error) => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            }
        );
    });
}

export function createStepBroker(): StepBroker {
    const slots = new Map<string, Slot>();

    const submit = (token: string, step: StepRequest, signal?: AbortSignal): Promise<StepResult> => {
        const slot = slots.get(token);
        if (!slot) return Promise.reject(new StepChannelClosed(`step ${step.id} was queued`));
        if (slot.gone) return Promise.reject(new StepChannelClosed(`step ${step.id} was queued: ${slot.gone}`));
        const key = callKey(step.id, step.invocation);
        const known = slot.waiters.get(key);
        if (known) return abortable(known.promise, signal, `step ${step.id}`);
        let resolve!: (result: StepResult) => void;
        let reject!: (error: Error) => void;
        const promise = new Promise<StepResult>((res, rej) => {
            resolve = res;
            reject = rej;
        });
        // A waiter nobody joins after its caller gave up must not become an unhandled rejection.
        promise.catch(() => undefined);
        const lost = setTimeout(() => {
            // The step leaves the queue too: a redelivery of the same call is queued afresh.
            slot.waiters.delete(key);
            const queued = slot.queue.indexOf(step);
            if (queued >= 0) slot.queue.splice(queued, 1);
            reject(new StepTimedOut(step.id));
        }, step.timeoutMs + STEP_ANSWER_GRACE_MS);
        promise.then(
            () => clearTimeout(lost),
            () => clearTimeout(lost)
        );
        slot.waiters.set(key, { resolve, reject, promise });
        const poller = slot.pollers.shift();
        if (poller) poller.resolve(step);
        else slot.queue.push(step);
        return abortable(promise, signal, `step ${step.id}`);
    };

    return {
        open(token) {
            if (!slots.has(token)) slots.set(token, newSlot());
        },
        close(token) {
            const slot = slots.get(token);
            if (!slot) return;
            slots.delete(token);
            for (const waiter of slot.waiters.values()) waiter.reject(new StepChannelClosed('its step was answered'));
            for (const poller of slot.pollers) poller.resolve(null);
            for (const waiter of slot.reportWaiters) waiter.reject(new StepChannelClosed('the supervisor reported'));
        },
        has: (token) => slots.has(token),
        submit,
        release(token) {
            const slot = slots.get(token);
            if (!slot) return;
            abandon(slot, 'the task group ended or was taken away');
            dropReportWaiters(slot);
        },
        attach(token) {
            const slot = slots.get(token);
            if (!slot) return;
            dropReportWaiters(slot);
            if (slot.reported) slot.retired.add(slot.reported.id);
            Object.assign(slot, { contacted: false, reported: null, gone: null });
        },
        awaitReport(token, signal) {
            const slot = slots.get(token);
            if (!slot) return Promise.reject(new StepChannelClosed('the supervisor reported'));
            if (slot.reported) return Promise.resolve(slot.reported);
            // A group gone with no report taken never reports.
            if (slot.gone) return Promise.reject(new StepChannelClosed('the supervisor reported'));
            const waiting = new Promise<SupervisorReport>((resolve, reject) => {
                slot.reportWaiters.push({ resolve, reject });
            });
            waiting.catch(() => undefined);
            return abortable(waiting, signal, 'the wait for the supervisor report');
        },
        contacted: (token) => slots.get(token)?.contacted ?? false,
        async next(token, waitMs, signal) {
            const slot = slots.get(token);
            if (!slot) return 'closed';
            slot.contacted = true;
            const queued = slot.queue.shift();
            if (queued) return queued;
            if (waitMs <= 0 || signal.aborted) return null;
            return new Promise<StepRequest | null>((resolve) => {
                const poller: Poller = { resolve: (step) => finish(step) };
                const timer = setTimeout(() => finish(null), waitMs);
                const onAbort = () => finish(null);
                const finish = (step: StepRequest | null) => {
                    clearTimeout(timer);
                    signal.removeEventListener('abort', onAbort);
                    const at = slot.pollers.indexOf(poller);
                    if (at >= 0) slot.pollers.splice(at, 1);
                    resolve(step);
                };
                signal.addEventListener('abort', onAbort, { once: true });
                slot.pollers.push(poller);
            });
        },
        settle(token, id, invocation, result) {
            const slot = slots.get(token);
            const key = callKey(id, invocation);
            const waiter = slot?.waiters.get(key);
            if (!slot || !waiter) return false;
            slot.waiters.delete(key);
            waiter.resolve(result);
            return true;
        },
        report(token, report) {
            const slot = slots.get(token);
            return slot ? takeReport(slot, report) : 'conflict';
        },
    };
}

/** The sink of a driver with no control endpoint: every step is refused, saying why. */
export const noStepChannel: StepSink = {
    submit: (_token, step) =>
        Promise.reject(
            new Error(`cannot run step ${step.id}: this attempt has no supervisor control channel (no endpoint opened)`)
        ),
    awaitReport: () => Promise.reject(new Error('this attempt has no supervisor control channel')),
    contacted: () => false,
    release: () => undefined,
    attach: () => undefined,
};

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_CONFLICT = 409;
const HTTP_PAYLOAD_TOO_LARGE = 413;
/** A call's invocation, in the supervisor's step-id alphabet. */
const INVOCATION = /^[A-Za-z0-9_.:-]{1,160}$/;
/** A step result carries two capped streams plus a little framing; anything larger is not one. */
const STEP_ANSWER_FRAMING_BYTES = 4096;
const STEP_RESULT_BODY_LIMIT = STEP_OUTPUT_LIMIT_BYTES * 2 + STEP_ANSWER_FRAMING_BYTES;
const REPORT_BODY_LIMIT = 16_384;
/** The longest wait one `GET /step` may ask for. */
const STEP_POLL_MAX_WAIT_MS = 30_000;

export interface StepAnswer {
    status: number;
    body: unknown;
}

/** `GET /step?wait=<ms>`: the next queued step, `{}` when none came in time. */
export async function serveStepPoll(
    broker: StepBroker,
    token: string,
    request: IncomingMessage,
    hangup: AbortSignal
): Promise<StepAnswer> {
    const query = new URL(request.url ?? STEP_PATH, 'http://driver').searchParams;
    const asked = Number(query.get('wait') ?? '0');
    const wait = Number.isFinite(asked) ? Math.min(Math.max(asked, 0), STEP_POLL_MAX_WAIT_MS) : 0;
    const next = await broker.next(token, wait, hangup);
    if (next === 'closed') return { status: HTTP_UNAUTHORIZED, body: { error: 'unknown token' } };
    return { status: HTTP_OK, body: next ? { step: next } : {} };
}

const parseResult = (raw: string): { invocation: string; result: StepResult } | null => {
    const parsed = parseJsonObject(raw);
    if (!parsed) return null;
    const { invocation, exitCode, stdout, stderr, timedOut } = parsed;
    if (typeof invocation !== 'string' || !INVOCATION.test(invocation)) return null;
    if (exitCode !== null && typeof exitCode !== 'number') return null;
    if (typeof stdout !== 'string' || typeof stderr !== 'string' || typeof timedOut !== 'boolean') return null;
    return { invocation, result: { exitCode, stdout, stderr, timedOut } };
};

/** `POST /step/:id`: the supervisor's answer to one call of a step. */
export async function serveStepResult(
    broker: StepBroker,
    token: string,
    request: IncomingMessage
): Promise<StepAnswer> {
    const id = decodeURIComponent((request.url ?? '').slice(STEP_PATH.length + 1));
    const raw = await readBody(request, STEP_RESULT_BODY_LIMIT);
    if (raw === null) return { status: HTTP_PAYLOAD_TOO_LARGE, body: { error: 'body too large' } };
    const answer = parseResult(raw);
    if (!answer) return { status: HTTP_BAD_REQUEST, body: { error: 'not a step result' } };
    // An answer for a call nobody waits for (already settled, or its caller gave up) is still
    // acknowledged: the supervisor stops resending it.
    broker.settle(token, id, answer.invocation, answer.result);
    return { status: HTTP_OK, body: { ok: true } };
}

const parseReport = (raw: string): SupervisorReport | null => {
    const parsed = parseJsonObject(raw);
    if (!parsed || typeof parsed.agentEnd !== 'string' || typeof parsed.drained !== 'boolean') return null;
    const { id, outcome, cause, agentExit, serving } = parsed;
    if (typeof id !== 'string' || id === '' || typeof serving !== 'boolean') return null;
    return {
        id,
        serving,
        outcome: typeof outcome === 'string' ? outcome : null,
        cause: typeof cause === 'string' ? cause : null,
        agentExit: typeof agentExit === 'number' ? agentExit : null,
        agentEnd: parsed.agentEnd,
        drained: parsed.drained,
    };
};

/** `POST /report`: the agent is over and the exporter drained; a redelivery is acknowledged, another report refused. */
export async function serveReport(broker: StepBroker, token: string, request: IncomingMessage): Promise<StepAnswer> {
    const raw = await readBody(request, REPORT_BODY_LIMIT);
    if (raw === null) return { status: HTTP_PAYLOAD_TOO_LARGE, body: { error: 'body too large' } };
    const report = parseReport(raw);
    if (!report) return { status: HTTP_BAD_REQUEST, body: { error: 'not a supervisor report' } };
    if (broker.report(token, report) === 'conflict') {
        return { status: HTTP_CONFLICT, body: { error: 'another report was taken for this attempt' } };
    }
    return { status: HTTP_OK, body: { ok: true } };
}
