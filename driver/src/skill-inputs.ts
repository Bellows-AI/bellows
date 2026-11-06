import type { BoardJob } from './board/board.js';
import { skillInstallScript } from './container-scripts.js';
import { SKILLS_DELIVERY } from './input-control.js';
import { parseLastJsonLine } from './json-parse.js';
import type { SyncResult } from './publish/publish.js';
import { detailOf, stepRequest, submitStep, type StepHost } from './supervised-steps.js';
import { deliverTaskInputs, hasInputs, INPUTS_DEADLINE_MS, InputsUnconfirmed } from './task-inputs.js';
import { SKILLS_DIR } from './task-volume.js';

/** Whether the claim pins skills to install, or carries a pin this client could not read (which is owed an answer, not skipped). */
export const hasSkills = (job: Pick<BoardJob, 'skillPin' | 'skillPinUnreadable'>): boolean =>
    (job.skillPin?.length ?? 0) > 0 || job.skillPinUnreadable !== undefined;

/** Whether the claim owes the attempt anything delivered before the agent is released. */
export const hasClaimInputs = (job: Pick<BoardJob, 'attachments' | 'skillPin' | 'skillPinUnreadable'>): boolean =>
    hasInputs(job) || hasSkills(job);

/** What the install script's last stdout line says (`scripts/skill-install.cjs`). */
interface SkillsVerdict {
    ok: boolean;
    reason?: string;
    kind?: string;
}

/**
 * Installs the claim's pinned org and workspace skills into `SKILLS_DIR` as one supervised `skills` step, before the
 * agent is released. Resolves ok when nothing is pinned or the skills are in place, refuses with `skill_unavailable`
 * when the board will never deliver one (its bytes gone, corrupt or not a safe skill), and THROWS on everything else:
 * a transient board failure, a timeout, an unreadable answer, a pin this client could not read. The loop then leaves
 * the claim to its lease, because an unconfirmed install is never a verdict.
 */
export async function deliverSkills(
    host: StepHost,
    job: BoardJob,
    options: { signal?: AbortSignal | undefined } = {}
): Promise<SyncResult> {
    if (job.skillPinUnreadable !== undefined) throw new InputsUnconfirmed(job.skillPinUnreadable);
    const pin = job.skillPin ?? [];
    if (pin.length === 0) return { ok: true, reason: null };
    const result = await submitStep(
        host,
        job,
        stepRequest(job, 'sync', {
            id: 'skills',
            argv: ['node', '--no-warnings', '-e', skillInstallScript],
            env: {
                TARGET_DIR: SKILLS_DIR,
                PIN: JSON.stringify(pin),
                INPUT_DELIVERY: SKILLS_DELIVERY,
                STAGING_SEQ: String(job.claimSeq),
                // The supervisor lays its control endpoint and token over this one step only.
                INPUT_FEED: '1',
            },
            timeoutMs: INPUTS_DEADLINE_MS,
        }),
        options.signal
    );
    if (result.timedOut) throw new InputsUnconfirmed(detailOf(result, INPUTS_DEADLINE_MS));
    const unreadable: SkillsVerdict = { ok: false, reason: detailOf(result, INPUTS_DEADLINE_MS) };
    const verdict = parseLastJsonLine<SkillsVerdict>(result.stdout, () => unreadable);
    if (verdict.ok) return { ok: true, reason: null };
    if (verdict.kind === 'skill_unavailable') {
        return { ok: false, reason: verdict.reason ?? 'a skill is no longer available', kind: verdict.kind };
    }
    throw new InputsUnconfirmed(verdict.reason ?? detailOf(result, INPUTS_DEADLINE_MS));
}

/** The attempt's claim inputs, both before the agent is released: the attachments, then the pinned skills. The first refusal wins. */
export async function deliverClaimInputs(
    host: StepHost,
    job: BoardJob,
    options: { signal?: AbortSignal | undefined } = {}
): Promise<SyncResult> {
    const attached = await deliverTaskInputs(host, job, options);
    return attached.ok ? deliverSkills(host, job, options) : attached;
}
