#!/usr/bin/env node
// How `scripts/test-jobs.sh --parallel` fans the lane out: phases are grouped (each group is one
// `test-jobs.sh --phase a,b` run with its own board fixture, database and run-specific names) and
// the groups are dealt to a fixed number of slots, heaviest first onto the lightest slot. Pinned by
// server/test/test-jobs.groups.test.ts: the groups partition PHASES exactly.
//
//   node scripts/test-jobs-groups.mjs <slots> <all | phase[,phase...]>
//
// stdout: one `<slot>\t<group>\t<phases>` line per group, in the order a slot runs them.
import { pathToFileURL } from 'node:url';
import { PHASES } from './test-jobs-changed.mjs';

// Seconds a phase takes alone (artifacts/jobs timings; a phase with no recorded run is an estimate).
// Only the ratio matters: it decides which slot a group lands on, never whether a phase runs.
const PHASE_SECONDS = {
    board: 15,
    driver: 69,
    'github-credential': 22,
    services: 18,
    'orphan-reaper': 18,
    'node-disruption': 102,
    'driver-kill': 60,
    'run-deadline': 40,
    capacity: 45,
    review: 40,
    workflows: 48,
    acceptance: 60,
    'compose-driver': 90,
    auth: 4,
    'cooperative-stop': 79,
    'tool-isolation': 84,
    'image-checks': 60,
    'ask-user-question': 35,
    'question-round-trip': 67,
};
// What one group spends before its first phase: Postgres database, stub images, board boot.
const GROUP_OVERHEAD_SECONDS = 10;

export const GROUPS = [
    { name: 'disruption', phases: ['node-disruption', 'driver-kill'] },
    { name: 'engine', phases: ['workflows', 'compose-driver', 'acceptance'] },
    { name: 'cli-stop', phases: ['cooperative-stop', 'tool-isolation', 'image-checks'] },
    { name: 'core', phases: ['board', 'driver', 'github-credential', 'services', 'orphan-reaper', 'auth'] },
    { name: 'guards', phases: ['run-deadline', 'capacity', 'review'] },
    { name: 'cli-ask', phases: ['ask-user-question', 'question-round-trip'] },
];

/** The slots for `selected` phases (all of PHASES when null): `[{ groups: [{ name, phases }], seconds }]`. */
export function plan(selected, slotCount) {
    const wanted = selected === null ? PHASES : selected;
    const unknown = wanted.filter((phase) => !PHASES.includes(phase));
    if (unknown.length > 0) throw new Error(`unknown phase: ${unknown.join(',')}`);
    const slots = Array.from({ length: slotCount }, () => ({ groups: [], seconds: 0 }));
    const groups = GROUPS.map((group) => ({ name: group.name, phases: group.phases.filter((p) => wanted.includes(p)) }))
        .filter((group) => group.phases.length > 0)
        .map((group) => ({
            ...group,
            seconds: GROUP_OVERHEAD_SECONDS + group.phases.reduce((sum, phase) => sum + PHASE_SECONDS[phase], 0),
        }))
        .sort((a, b) => b.seconds - a.seconds);
    for (const group of groups) {
        const lightest = slots.reduce((best, slot) => (slot.seconds < best.seconds ? slot : best));
        lightest.groups.push({ name: group.name, phases: group.phases });
        lightest.seconds += group.seconds;
    }
    return slots.filter((slot) => slot.groups.length > 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    const [slotArg, phaseArg] = process.argv.slice(2);
    const slotCount = Number(slotArg);
    if (!Number.isInteger(slotCount) || slotCount < 1 || !phaseArg) {
        console.error('usage: test-jobs-groups.mjs <slots> <all | phase[,phase...]>');
        process.exit(2);
    }
    try {
        plan(phaseArg === 'all' ? null : phaseArg.split(','), slotCount).forEach((slot, index) => {
            for (const group of slot.groups) console.log(`${index}\t${group.name}\t${group.phases.join(',')}`);
        });
    } catch (e) {
        console.error(e.message);
        process.exit(2);
    }
}
