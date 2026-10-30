import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NOTIFICATION_KINDS, notificationEventOf, type NotificationEventRow } from '../src/notifications.js';

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
