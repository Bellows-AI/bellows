import { describe, expect, it, vi } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import type { ClaimAttachment } from '../src/board/board-attachments.js';
import { attachReviewInputs, attachTaskInputs } from '../src/loop/loop-inputs.js';
import { SKILLS_DELIVERY } from '../src/input-control.js';

const FILE: ClaimAttachment = {
    id: '33333333-3333-4333-8333-333333333333',
    name: 'notes.txt',
    mediaType: 'text/plain',
    size: 5,
    sha256: 'a'.repeat(64),
    originJobId: '11111111-1111-4111-8111-111111111111',
};
const job = (attachments?: ClaimAttachment[]) =>
    ({ id: FILE.originJobId, leaseToken: 'lease-1', attachments }) as unknown as BoardJob;

describe('attaching the task inputs to a control token', () => {
    it('registers the task delivery, read under the task lease', async () => {
        const attach = vi.fn();
        const attachmentContent = vi.fn(async () => ({ bytes: Buffer.from('x'), sha256: 'a'.repeat(64) }));
        const rt = { gates: { server: { attachInputs: attach } }, board: { attachmentContent } } as never;

        attachTaskInputs({ rt, job: job([FILE]) }, 'token');

        expect(attach).toHaveBeenCalledWith('token', 'task', expect.objectContaining({ manifest: [FILE] }));
        await attach.mock.calls[0]?.[2].read(FILE.id);
        expect(attachmentContent).toHaveBeenCalledWith({ id: FILE.originJobId, leaseToken: 'lease-1' }, FILE.id);
    });

    it.each([[undefined], [[]]])('registers nothing for a claim with no attachments (%j)', (attachments) => {
        const attach = vi.fn();
        attachTaskInputs(
            { rt: { gates: { server: { attachInputs: attach } }, board: {} } as never, job: job(attachments) },
            'token'
        );
        expect(attach).not.toHaveBeenCalled();
    });

    it('registers nothing where the run has no control endpoint', () => {
        expect(() => attachTaskInputs({ rt: { board: {} } as never, job: job([FILE]) }, 'token')).not.toThrow();
    });
});

describe('attaching the pinned skills to a control token', () => {
    const PIN = [
        {
            name: 'org-style',
            source: 'org' as const,
            versionId: '77777777-7777-4777-8777-777777777777',
            sha256: 'b'.repeat(64),
        },
    ];
    const pinned = (extra: Record<string, unknown> = {}) =>
        ({ id: FILE.originJobId, leaseToken: 'lease-1', skillPin: PIN, ...extra }) as unknown as BoardJob;

    it('registers the skills delivery keyed by version id, read under the task lease', async () => {
        const attach = vi.fn();
        const skillContent = vi.fn(async () => ({ bytes: Buffer.from('x'), sha256: 'a'.repeat(64) }));
        const rt = { gates: { server: { attachInputs: attach } }, board: { skillContent } } as never;

        attachTaskInputs({ rt, job: pinned() }, 'token');

        expect(attach).toHaveBeenCalledTimes(1);
        expect(attach).toHaveBeenCalledWith(
            'token',
            SKILLS_DELIVERY,
            expect.objectContaining({ manifest: [{ id: PIN[0]!.versionId }] })
        );
        await attach.mock.calls[0]?.[2].read(PIN[0]!.versionId);
        expect(skillContent).toHaveBeenCalledWith({ id: FILE.originJobId, leaseToken: 'lease-1' }, PIN[0]!.versionId);
    });

    it('registers both deliveries for a claim with files and skills', () => {
        const attach = vi.fn();
        attachTaskInputs(
            {
                rt: { gates: { server: { attachInputs: attach } }, board: {} } as never,
                job: pinned({ attachments: [FILE] }),
            },
            'token'
        );
        expect(attach.mock.calls.map((call) => call[1])).toEqual(['task', SKILLS_DELIVERY]);
    });

    it('registers nothing for an empty pin', () => {
        const attach = vi.fn();
        attachTaskInputs(
            { rt: { gates: { server: { attachInputs: attach } }, board: {} } as never, job: pinned({ skillPin: [] }) },
            'token'
        );
        expect(attach).not.toHaveBeenCalled();
    });
});

describe('attaching a review’s input files to the caller’s control token', () => {
    const review = { id: 'rev-1', leaseToken: 'rev-lease', attachments: [FILE] } as unknown as BoardJob;

    it('registers the delivery under the review’s id, read under the review’s own lease', async () => {
        const attach = vi.fn();
        const attachmentContent = vi.fn(async () => ({ bytes: Buffer.from('x'), sha256: 'a'.repeat(64) }));
        const rt = { gates: { server: { attachInputs: attach } }, board: { attachmentContent } } as never;

        attachReviewInputs({ rt, review }, 'caller-token');

        expect(attach).toHaveBeenCalledWith('caller-token', 'rev-1', expect.objectContaining({ manifest: [FILE] }));
        await attach.mock.calls[0]?.[2].read(FILE.id);
        expect(attachmentContent).toHaveBeenCalledWith({ id: 'rev-1', leaseToken: 'rev-lease' }, FILE.id);
    });

    it('registers nothing for a review with no attachments', () => {
        const attach = vi.fn();
        attachReviewInputs(
            {
                rt: { gates: { server: { attachInputs: attach } }, board: {} } as never,
                review: { ...review, attachments: [] },
            },
            'caller-token'
        );
        expect(attach).not.toHaveBeenCalled();
    });
});
