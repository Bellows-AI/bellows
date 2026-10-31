import { describe, expect, it, vi } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import type { ClaimAttachment } from '../src/board/board-attachments.js';
import { attachTaskInputs } from '../src/loop/loop-inputs.js';

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
