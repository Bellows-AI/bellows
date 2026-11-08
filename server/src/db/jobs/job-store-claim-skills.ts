import { isReservedSkillName, skillSelectionProblems } from '@factory-ai/core';
import { skillCatalog } from '../../skills.js';
import type { PinnedSkill } from './job-store-skill-pin.js';

/**
 * The sentence that stops a claim whose selected skills cannot run, or null (issue #545): a
 * selection the catalog lacks, a skill whose connection has no env names in the claim's resolved
 * env, or a managed connection the task never selected (`managed`; whether it is still authorized
 * is the broker's per-call check, docs/connections.md). Config-kind and recoverable — the member fixes the settings and retries.
 * A name the row's own `pin` holds is delivered at the pinned version whatever the live catalog says now: a skill
 * disabled or deleted after the row was made still runs it (BEL-273).
 */
export function resolveClaimSkills(
    skills: readonly string[],
    claimEnv: Readonly<Record<string, string>> | undefined,
    options: { managed?: readonly string[]; repo?: string | null; pin?: readonly PinnedSkill[] } = {}
): string | null {
    const { managed = [], repo = null, pin = [] } = options;
    const catalog = skillCatalog();
    const pinned = new Set(pin.map((entry) => entry.name));
    const unpinned = skills.filter((name) => !pinned.has(name));
    // The claim cannot read GitHub inside its transaction, and create already checked the name: on a repo job a name
    // the board does not hold is the checkout's own skill, which declares no requirements. A reserved-prefix name is
    // never a repo skill, so it stays refused.
    const held = (name: string) => isReservedSkillName(name) || catalog.some((skill) => skill.name === name);
    const checked = repo === null ? unpinned : unpinned.filter(held);
    const problems = skillSelectionProblems(catalog, checked, claimEnv ?? {}, managed);
    return problems.length === 0 ? null : `[skills unavailable] ${problems.join('; ')}. Fix this, then retry the task.`;
}
