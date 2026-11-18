import { delimiter } from 'node:path';

/**
 * The environment without what a gate shell (`driver/src/scripts/gate-shell.sh`) adds to it. When the suite runs
 * as a board task's gate, every child inherits the gate's `FACTORY_GATE_*` mailbox, its `gh` shim first on the
 * PATH and the `GIT_CONFIG_*` pairs that point git's github.com helper at that shim: a test that spawns git or a
 * `gh` of its own would ask the real gate instead of its fake.
 */
export function withoutGateEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const clean = { ...env };
    const gateBin = clean.FACTORY_GATE_BIN;
    for (const name of Object.keys(clean)) {
        if (name.startsWith('FACTORY_GATE_') || /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(name)) delete clean[name];
    }
    if (gateBin && clean.PATH) {
        clean.PATH = clean.PATH.split(delimiter)
            .filter((entry) => entry !== gateBin)
            .join(delimiter);
    }
    return clean;
}
