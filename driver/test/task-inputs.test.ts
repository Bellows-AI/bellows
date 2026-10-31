import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import type { ClaimAttachment } from '../src/board/board-attachments.js';
import { attachmentsDir } from '../src/claim.js';
import { loadDriverConfig } from '../src/config.js';
import type { StepSink } from '../src/step-control.js';
import { SUPERVISOR_ENV, type StepRequest } from '../src/supervisor-contract.js';
import { deliverTaskInputs, INPUTS_DEADLINE_MS } from '../src/task-inputs.js';

const ROOT = '11111111-1111-4111-8111-111111111111';
const FILE: ClaimAttachment = {
    id: '33333333-3333-4333-8333-333333333333',
    name: 'notes.txt',
    mediaType: 'text/plain',
    size: 5,
    sha256: 'a'.repeat(64),
    originJobId: ROOT,
};
const job = (over: { attachments?: ClaimAttachment[] | undefined } = {}): BoardJob =>
    ({
        id: ROOT,
        rootJobId: ROOT,
        repo: null,
        claimSeq: 4,
        leaseToken: '22222222-2222-4222-8222-222222222222',
        attachments: [FILE],
        supervisorEnv: { [SUPERVISOR_ENV.controlUrl]: 'http://driver:8130', [SUPERVISOR_ENV.controlToken]: 'tok' },
        ...over,
    }) as unknown as BoardJob;

const host = (answer: (step: StepRequest) => { stdout: string; timedOut?: boolean; exitCode?: number | null }) => {
    const steps: StepRequest[] = [];
    const sink = {
        submit: async (_token: string, step: StepRequest) => {
            steps.push(step);
            const out = answer(step);
            return { exitCode: 0, stderr: '', timedOut: false, ...out };
        },
    } as unknown as StepSink;
    return { steps, host: { config: loadDriverConfig({}), sink } };
};

describe('deliverTaskInputs', () => {
    it('submits one inputs step with the manifest, the target and the whole-step deadline, and resolves on ok', async () => {
        const h = host(() => ({ stdout: '{"ok":true,"files":1,"fetched":1}' }));
        expect(await deliverTaskInputs(h.host, job())).toEqual({ ok: true, reason: null });
        expect(h.steps).toHaveLength(1);
        expect(h.steps[0]).toMatchObject({
            kind: 'sync',
            timeoutMs: INPUTS_DEADLINE_MS,
            env: { INPUT_FEED: '1', INPUT_DELIVERY: 'task', TARGET_DIR: attachmentsDir(job()), STAGING_SEQ: '4' },
        });
        expect(h.steps[0]?.id).toMatch(/-inputs$/);
        expect(JSON.parse(h.steps[0]?.env.MANIFEST ?? '')).toEqual([FILE]);
    });

    it('takes the delivery name, manifest and target as parameters so a review can reuse it', async () => {
        const h = host(() => ({ stdout: '{"ok":true}' }));
        await deliverTaskInputs(h.host, job({ attachments: undefined }), {
            delivery: 'review-1',
            manifest: [FILE],
            targetDir: '/home/reviewer/attachments',
        });
        expect(h.steps[0]?.env).toMatchObject({ INPUT_DELIVERY: 'review-1', TARGET_DIR: '/home/reviewer/attachments' });
    });

    it('is a refusal of kind attachment_unavailable when the script says the board will never deliver', async () => {
        const h = host(() => ({ stdout: 'noise\n{"ok":false,"reason":"gone","kind":"attachment_unavailable"}\n' }));
        expect(await deliverTaskInputs(h.host, job())).toEqual({
            ok: false,
            reason: 'gone',
            kind: 'attachment_unavailable',
        });
    });

    it.each([
        ['a transient failure', { stdout: '{"ok":false,"reason":"board 503","transient":true}' }],
        ['a timed out step', { stdout: '', timedOut: true, exitCode: null }],
        ['a step with no JSON line', { stdout: 'boom', exitCode: 1 }],
        ['a failure naming neither kind nor transient', { stdout: '{"ok":false,"reason":"disk full"}' }],
    ])('throws on %s, so the lease hands the claim back', async (_name, answer) => {
        const h = host(() => answer);
        await expect(deliverTaskInputs(h.host, job())).rejects.toThrow();
    });

    it.each([[undefined], [[]]])('submits no step without attachments (%j)', async (attachments) => {
        const h = host(() => ({ stdout: '{"ok":true}' }));
        expect(await deliverTaskInputs(h.host, job({ attachments }))).toEqual({ ok: true, reason: null });
        expect(h.steps).toEqual([]);
    });
});
