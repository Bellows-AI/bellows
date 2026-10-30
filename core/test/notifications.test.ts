import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    isSendResult,
    NOTIFICATION_KINDS,
    notificationEventOf,
    type NotificationEventRow,
} from '../src/notifications.js';

const row = (over: Partial<NotificationEventRow> = {}): NotificationEventRow => ({
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'task.blocked',
    orgId: '42',
    jobId: '22222222-2222-4222-8222-222222222222',
    rootJobId: '33333333-3333-4333-8333-333333333333',
    repo: 'acme/widgets',
    workflow: 'walk',
    command: 'fix the flaky test\nsecond line',
    reason: 'policy',
    prUrl: null,
    questionId: null,
    questions: null,
    occurredAt: '2026-10-30T10:00:00.000Z',
    ...over,
});

describe('notificationEventOf', () => {
    it('maps every field of the row', () => {
        expect(notificationEventOf(row(), 'https://factory.example.com')).toEqual({
            id: '11111111-1111-4111-8111-111111111111',
            kind: 'task.blocked',
            orgId: '42',
            jobId: '22222222-2222-4222-8222-222222222222',
            threadId: '33333333-3333-4333-8333-333333333333',
            repo: 'acme/widgets',
            workflow: 'walk',
            title: 'fix the flaky test',
            reason: 'policy',
            prUrl: null,
            questionId: null,
            questions: null,
            link: 'https://factory.example.com/tasks/33333333-3333-4333-8333-333333333333',
            occurredAt: '2026-10-30T10:00:00.000Z',
        });
    });

    it('keeps null repo, workflow and reason', () => {
        expect(
            notificationEventOf(row({ repo: null, workflow: null, reason: null }), 'https://x.example')
        ).toMatchObject({
            repo: null,
            workflow: null,
            reason: null,
        });
    });

    it('passes the PR link through, or null', () => {
        const prUrl = 'https://github.com/acme/widgets/pull/7';
        expect(notificationEventOf(row({ prUrl }), 'https://x.example').prUrl).toBe(prUrl);
        expect(notificationEventOf(row({ prUrl: null }), 'https://x.example').prUrl).toBeNull();
    });

    it('passes the question id and texts through', () => {
        const event = notificationEventOf(
            row({ kind: 'task.question', questionId: 'toolu_1', questions: ['Which db?'] }),
            'https://x.example'
        );
        expect(event).toMatchObject({ questionId: 'toolu_1', questions: ['Which db?'] });
        expect(event.link).toBe(`https://x.example/tasks/${row().rootJobId}`);
    });

    it('derives the title from the command, for a multi-line and a CRLF command', () => {
        expect(notificationEventOf(row({ command: '  first  \nsecond' }), 'https://x.example').title).toBe('first');
        expect(notificationEventOf(row({ command: 'first\r\nsecond' }), 'https://x.example').title).toBe('first');
    });

    it('links to the thread with or without a trailing slash on the public url', () => {
        const root = row().rootJobId;
        expect(notificationEventOf(row(), 'https://x.example').link).toBe(`https://x.example/tasks/${root}`);
        expect(notificationEventOf(row(), 'https://x.example/').link).toBe(`https://x.example/tasks/${root}`);
    });
});

describe('NOTIFICATION_KINDS', () => {
    it('lists the three kinds, and the migration check admits exactly them', () => {
        expect([...NOTIFICATION_KINDS]).toEqual(['task.ready', 'task.blocked', 'task.question']);
        const sql = readFileSync(
            new URL('../../server/migrations/102_notification_event.sql', import.meta.url),
            'utf8'
        );
        const check = /kind in \(([^)]*)\)/.exec(sql);
        expect(check).not.toBeNull();
        expect([...check![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1])).toEqual([...NOTIFICATION_KINDS]);
    });
});

describe('isSendResult', () => {
    it('accepts each class', () => {
        for (const ok of [
            { status: 'delivered' },
            { status: 'delivered', externalId: 'm1' },
            { status: 'retryable', reason: 'transport' },
            { status: 'retryable', reason: 'rate-limited', retryAfterMs: 0 },
            { status: 'retryable', reason: 'credential-unavailable' },
            { status: 'permanent', reason: 'payload-refused' },
        ]) {
            expect(isSendResult(ok), JSON.stringify(ok)).toBe(true);
        }
    });

    it('rejects malformed', () => {
        for (const bad of [
            null,
            undefined,
            'delivered',
            { status: 'nope' },
            { status: 'retryable', reason: 'config-invalid' },
            { status: 'permanent', reason: 'transport' },
            { status: 'permanent', reason: 'nope' },
            { status: 'retryable' },
            { status: 'delivered', body: 'x' },
            { status: 'permanent', reason: 'payload-refused', message: 'tok' },
            { status: 'permanent', reason: 'payload-refused', retryAfterMs: 1 },
            { status: 'delivered', externalId: '' },
            { status: 'delivered', externalId: 7 },
            { status: 'retryable', reason: 'transport', retryAfterMs: -1 },
            { status: 'retryable', reason: 'transport', retryAfterMs: Number.NaN },
            { status: 'retryable', reason: 'transport', retryAfterMs: Number.POSITIVE_INFINITY },
            { status: 'retryable', reason: 'transport', retryAfterMs: '5' },
        ]) {
            expect(isSendResult(bad), JSON.stringify(bad)).toBe(false);
        }
    });
});
