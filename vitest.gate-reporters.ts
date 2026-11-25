import { fileURLToPath } from 'node:url';

/**
 * Inside a gate (`FACTORY_GATE_RUN` names the request's directory) every vitest run adds the gate reporter beside
 * the default one, so the failures, the files in flight and the durations reach the gate's report even when its
 * output tail is cut or the gate is killed at its deadline. The root, executors and db configs spread this, so
 * `test`, `test:db` and `test:executors` are covered, and a new vitest gate is too. Outside a gate: nothing.
 */
export const gateReporters = (env: NodeJS.ProcessEnv = process.env): { reporters?: string[] } =>
    env.FACTORY_GATE_RUN
        ? { reporters: ['default', fileURLToPath(new URL('./scripts/gate-reporter.mjs', import.meta.url))] }
        : {};
