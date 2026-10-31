import type { BoardJob } from './board/board.js';
import type { ClaimAttachment } from './board/board-attachments.js';
import { attachmentExtractScript, attachmentFetchScript } from './container-scripts.js';
import { parseLastJsonLine } from './json-parse.js';
import type { SyncResult } from './publish/publish.js';
import { detailOf, stepRequest, submitStep, type StepHost } from './supervised-steps.js';
import { attachmentsDir } from './task-volume.js';

/** The inputs step's own bound: one absolute deadline for every request, retry and sleep of the script. */
export const INPUTS_DEADLINE_MS = 600_000;

/** The delivery name a task's inputs are served under (`INPUT_DELIVERY` of the inputs step). */
export const TASK_DELIVERY = 'task';

/** A fetch nothing confirmed either way (a board failure, a timeout, an unreadable answer): no verdict on the run. */
export class InputsUnconfirmed extends Error {
    constructor(reason: string) {
        super(`the task inputs step failed: ${reason}`);
        this.name = 'InputsUnconfirmed';
    }
}

/** Whether the claim carries task inputs to deliver. */
export const hasInputs = (job: Pick<BoardJob, 'attachments'>): boolean => (job.attachments?.length ?? 0) > 0;

/** What the fetch script's last stdout line says (`scripts/attachment-fetch.cjs`). */
interface InputsVerdict {
    ok: boolean;
    reason?: string;
    kind?: string;
    transient?: boolean;
}

/**
 * Writes a delivery's files and `manifest.json` into `targetDir` as one supervised `inputs` step, before the agent is
 * released. A task's delivery is the default; a review passes its own delivery name, manifest and directory.
 * Resolves ok when nothing is owed or the files are in place, refuses with `attachment_unavailable` when the board
 * will never deliver one, and THROWS on everything else — a transient board failure, a timeout, an unreadable answer —
 * so the loop leaves the claim to its lease: an unconfirmed fetch is never a verdict.
 */
export async function deliverTaskInputs(
    host: StepHost,
    job: BoardJob,
    options: {
        delivery?: string;
        manifest?: readonly ClaimAttachment[] | undefined;
        targetDir?: string;
        /** The row whose control channel hosts the step, when it is not `job` itself (a review in its caller's group). */
        owner?: BoardJob;
        signal?: AbortSignal | undefined;
    } = {}
): Promise<SyncResult> {
    const manifest = options.manifest ?? job.attachments ?? [];
    if (manifest.length === 0) return { ok: true, reason: null };
    const result = await submitStep(
        host,
        options.owner ?? job,
        stepRequest(job, 'sync', {
            id: 'inputs',
            argv: ['node', '--no-warnings', '-e', attachmentFetchScript],
            env: {
                TARGET_DIR: options.targetDir ?? attachmentsDir(job),
                MANIFEST: JSON.stringify(manifest),
                INPUT_DELIVERY: options.delivery ?? TASK_DELIVERY,
                STAGING_SEQ: String(job.claimSeq),
                // The supervisor lays its control endpoint and token over this one step only.
                INPUT_FEED: '1',
                // Run by the fetch script over the published directory, so task and reviewer deliveries both extract.
                EXTRACT_SCRIPT: attachmentExtractScript,
            },
            timeoutMs: INPUTS_DEADLINE_MS,
        }),
        options.signal
    );
    if (result.timedOut) throw new InputsUnconfirmed(detailOf(result, INPUTS_DEADLINE_MS));
    const unreadable: InputsVerdict = { ok: false, reason: detailOf(result, INPUTS_DEADLINE_MS) };
    const verdict = parseLastJsonLine<InputsVerdict>(result.stdout, () => unreadable);
    if (verdict.ok) return { ok: true, reason: null };
    if (verdict.kind === 'attachment_unavailable') {
        return { ok: false, reason: verdict.reason ?? 'an attachment is no longer available', kind: verdict.kind };
    }
    throw new InputsUnconfirmed(verdict.reason ?? detailOf(result, INPUTS_DEADLINE_MS));
}
