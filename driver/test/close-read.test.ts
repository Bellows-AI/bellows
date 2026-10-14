import { describe, expect, it } from 'vitest';
import {
    mergeOpencodeOutcome,
    type OpencodeRunOutcome,
    opencodeReadFailed,
    parseOpencodeRunOutcome,
    readOpencodeWithRetries,
} from '../src/close-read.js';
import type { RunOutcome } from '../src/runner.js';

/**
 * The opencode close-time readout's retry and merge, shared by both executors (docker: a
 * throwaway container per try; kubernetes: a Job per try). Each executor's own test pins only its
 * transport: the happy-path scrape and how a failed try reaches the outcome.
 */
const SESSION_LINE = '{"id":"ses_f86188c3dffeZGYO4yZq4atba9","finish":"length","tokens":90433,"cost":0.31}';
const PROVIDER_ERROR = 'Error from provider (Console): Rate limit exceeded. Please try again later.';

/** A readOnce that answers each scripted stdout in turn, and the sleeps it was asked for. */
const scripted = (answers: string[]) => {
    const sleeps: number[] = [];
    let reads = 0;
    const readOnce = async (): Promise<OpencodeRunOutcome> => parseOpencodeRunOutcome(answers[reads++] ?? '');
    const sleep = async (ms: number) => {
        sleeps.push(ms);
    };
    return { readOnce, sleep, sleeps, reads: () => reads };
};

const readAndMerge = async (answers: string[]) => {
    const t = scripted(answers);
    const { scraped, reason } = await readOpencodeWithRetries(t.readOnce, t.sleep);
    const outcome = { exitCode: 0, started: true } as RunOutcome;
    mergeOpencodeOutcome(outcome, scraped, reason);
    return { outcome, reads: t.reads(), sleeps: t.sleeps };
};

describe('the opencode session readout retry', () => {
    it('takes a session answered on the first try, without waiting', async () => {
        const { outcome, reads, sleeps } = await readAndMerge([SESSION_LINE]);

        expect(reads).toBe(1);
        expect(sleeps).toEqual([]);
        expect(outcome).toMatchObject({
            sessionId: 'ses_f86188c3dffeZGYO4yZq4atba9',
            finishReason: 'length',
            contextTokens: 90433,
            costUsd: 0.31,
        });
        expect(outcome.readoutError).toBeUndefined();
        // The line carried no turn count: unmeasured, never zero.
        expect(outcome.agentTurns).toBeUndefined();
    });

    // A database mid-checkpoint reads as silence or as an error, never as a session: both retry.
    it.each([
        ['silence', ''],
        ['an error line', '{"error":"database is locked"}'],
    ])('retries %s half a second later, and takes the session a later try answers', async (_name, first) => {
        const { outcome, reads, sleeps } = await readAndMerge([first, first, '{"id":"ses_late","finish":"stop"}']);

        expect(reads).toBe(3);
        expect(sleeps).toEqual([500, 500]);
        expect(outcome.sessionId).toBe('ses_late');
        expect(outcome.readoutError).toBeUndefined();
    });

    it('gives up after three tries, carrying the latest error any try answered', async () => {
        const { outcome, reads } = await readAndMerge([
            '{"error":"database is locked"}',
            '{"error":"no such column: role"}',
            '',
        ]);

        expect(reads).toBe(3);
        expect(outcome.sessionId).toBeUndefined();
        expect(outcome.readoutError).toBe('no such column: role');
    });

    it('says the database answered nothing when no try named a reason', async () => {
        const { outcome } = await readAndMerge(['', '', '']);

        expect(outcome.readoutError).toBe('the readout answered nothing (no session in the database)');
    });
});

describe('merging the readout onto the outcome', () => {
    // With a session scraped, the line's error is the RUN's last provider error — the cause of a
    // premature stop — and not a readout failure.
    it('carries the session’s last provider error beside the session', async () => {
        const { outcome } = await readAndMerge([
            JSON.stringify({ id: 'ses_x1', finish: 'tool-calls', tokens: 100016, cost: 0, error: PROVIDER_ERROR }),
        ]);

        expect(outcome).toMatchObject({
            sessionId: 'ses_x1',
            finishReason: 'tool-calls',
            providerError: PROVIDER_ERROR,
        });
        expect(outcome.readoutError).toBeUndefined();
    });

    it('rides the turn count, the summary and the blocked line on the outcome', async () => {
        const { outcome } = await readAndMerge([
            JSON.stringify({ id: 'ses_x1', finish: 'stop', turns: 9, summary: 'Fixed the flaky test', blocked: 'b' }),
        ]);

        expect(outcome).toMatchObject({ agentTurns: 9, summary: 'Fixed the flaky test', blockedLine: 'b' });
    });

    it('lands nothing but the reason from a failed read', () => {
        const outcome = { exitCode: 0, started: true } as RunOutcome;
        mergeOpencodeOutcome(outcome, opencodeReadFailed('the readout container failed: refused'), 'refused');

        expect(outcome).toEqual({ exitCode: 0, started: true, readoutError: 'refused' });
    });
});
