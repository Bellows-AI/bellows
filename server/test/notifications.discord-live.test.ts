import { NOTIFICATION_KINDS, type NotificationKind, notificationEventOf } from '@factory-ai/core';
import { describe, expect, it } from 'vitest';
import { createDiscordConnector } from '../src/notifications/discord.js';

/**
 * Manual check against a real test channel (BEL-132); CI never sets DISCORD_TEST_WEBHOOK_URL, so this skips.
 * Run: DISCORD_TEST_WEBHOOK_URL=<test channel webhook> npx vitest run server/test/notifications.discord-live.test.ts
 */
const WEBHOOK = process.env.DISCORD_TEST_WEBHOOK_URL;

const eventOf = (kind: NotificationKind) =>
    notificationEventOf(
        {
            id: '11111111-1111-4111-8111-111111111111',
            kind,
            orgId: 'live-check',
            jobId: '22222222-2222-4222-8222-222222222222',
            rootJobId: '33333333-3333-4333-8333-333333333333',
            repo: 'acme/widgets',
            workflow: null,
            command: `Live check: ${kind}\n@everyone must not ping`,
            reason: kind === 'task.blocked' ? 'a reason' : null,
            prUrl: null,
            questionId: kind === 'task.question' ? 'q1' : null,
            questions: kind === 'task.question' ? ['Which database?'] : null,
            action: kind === 'task.admin_action' ? 'follow-up' : null,
            actor: kind === 'task.admin_action' ? { id: 'u-admin', login: 'live-admin' } : null,
            author: kind === 'task.admin_action' ? { id: 'u-author', login: 'live-author' } : null,
            occurredAt: new Date().toISOString(),
        },
        'https://factory.example.com'
    );

describe.skipIf(!WEBHOOK)('discord live channel', () => {
    it.each(NOTIFICATION_KINDS)('delivers one %s embed with a message id', async (kind) => {
        const connector = createDiscordConnector();
        const credential = connector.validateCredential(WEBHOOK);
        if (!credential.ok) throw new Error('DISCORD_TEST_WEBHOOK_URL is not a Discord webhook URL');

        const result = await connector.send(eventOf(kind), {}, credential.config, AbortSignal.timeout(10_000));

        expect(result).toMatchObject({ status: 'delivered', externalId: expect.stringMatching(/^\d+$/) });
    });
});
