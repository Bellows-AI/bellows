// What a gate command records beside its output, for the driver to carry to the board (driver/src/gate-result.ts).
// A gate runs with FACTORY_GATE_RUN naming its request directory; `$FACTORY_GATE_RUN/report/<section>.json` is the
// mailbox: the gate loop keeps the directory in the answer even when the gate is killed at its deadline, so a section is
// written whole (rename) and early. Outside a gate (no FACTORY_GATE_RUN) every call here does nothing.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The report directory of the gate running this process, or null outside a gate. */
export function reportDir(env = process.env) {
    return env.FACTORY_GATE_RUN ? join(env.FACTORY_GATE_RUN, 'report') : null;
}

/** Writes `<dir>/<section>.json` atomically; best effort, a gate never fails for want of its report. */
export function writeSection(section, data, env = process.env) {
    const dir = reportDir(env);
    if (!dir) return;
    try {
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${section}.json`);
        writeFileSync(`${file}.tmp`, JSON.stringify(data));
        renameSync(`${file}.tmp`, file);
    } catch {
        // Not recorded.
    }
}

/** Reads a section a previous step of the same gate wrote, or null. */
export function readSection(section, env = process.env) {
    const dir = reportDir(env);
    if (!dir) return null;
    try {
        return JSON.parse(readFileSync(join(dir, `${section}.json`), 'utf8'));
    } catch {
        return null;
    }
}
