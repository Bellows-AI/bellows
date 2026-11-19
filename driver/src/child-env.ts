/**
 * The driver's own `OTEL_*` variables (an exporter header may carry a backend token) are for its SDK alone: a child
 * it spawns (`docker`) is handed an environment without them.
 */
const OTEL_PREFIX = 'OTEL_';

export function withoutOtelEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith(OTEL_PREFIX)));
}
