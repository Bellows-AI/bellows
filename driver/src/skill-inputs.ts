import type { BoardJob } from './board/board.js';
import { skillInstallScript } from './container-scripts.js';
import { SKILLS_DELIVERY } from './input-control.js';
import { parseLastJsonLine } from './json-parse.js';
import { checkoutDir, type SyncResult } from './publish/publish.js';
import { OPENCODE } from './executors.js';
import { detailOf, stepRequest, submitStep, type StepHost } from './supervised-steps.js';
import { deliverTaskInputs, hasInputs, INPUTS_DEADLINE_MS, InputsUnconfirmed } from './task-inputs.js';
import { SKILLS_DIR } from './task-volume.js';

/**
 * Whether the claim carries a pin: a list (an empty one included, which prunes what an earlier run installed) or one
 * this client could not read (owed an answer, not skipped). Only a row with no pin field at all is skipped.
 */
export const hasSkills = (job: Pick<BoardJob, 'skillPin' | 'skillPinUnreadable' | 'skillHiddenUnreadable'>): boolean =>
    job.skillPin !== undefined || job.skillPinUnreadable !== undefined || job.skillHiddenUnreadable !== undefined;

/** Whether the claim owes the attempt anything delivered before the agent is released. */
export const hasClaimInputs = (
    job: Pick<BoardJob, 'attachments' | 'skillPin' | 'skillPinUnreadable' | 'skillHiddenUnreadable'>
): boolean => hasInputs(job) || hasSkills(job);

/** What the install script's last stdout line says (`scripts/skill-install.cjs`). */
interface SkillsVerdict {
    ok: boolean;
    reason?: string;
    kind?: string;
    /** The pinned org skills the checkout holds itself and so were not installed (the repo's copy wins). */
    skipped?: string[];
}

/**
 * The checkout directories the job's CLI scans for skills — runnerPlan's CLI: a row with no executor type runs claude.
 * opencode also reads a checkout's `.claude/skills` (`docker/opencode-executor/test.sh`). A copy of core's
 * `checkoutSkillDirsOf`, pinned equal by `server/test/skill-dirs.driver-copy.test.ts`.
 */
export function checkoutSkillDirsOf(job: BoardJob): readonly string[] {
    return job.executorType === OPENCODE
        ? ['.claude/skills', '.opencode/skills', '.opencode/skill', '.agents/skills']
        : ['.claude/skills'];
}

/**
 * Installs the claim's pinned org and workspace skills into `SKILLS_DIR` as one supervised `skills` step, before the
 * agent is released. Resolves ok when the skills are in place (an empty pin prunes the ones an earlier run installed), refuses with `skill_unavailable`
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
    if (job.skillHiddenUnreadable !== undefined) throw new InputsUnconfirmed(job.skillHiddenUnreadable);
    if (job.skillPin === undefined) return { ok: true, reason: null };
    const pin = job.skillPin;
    const checkout = checkoutDir(job);
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
                // A pinned org skill the checkout holds where this CLI scans is not installed: the repo's copy wins.
                ...(checkout
                    ? { CHECKOUT_DIR: checkout, CHECKOUT_SKILL_DIRS: checkoutSkillDirsOf(job).join(',') }
                    : {}),
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
