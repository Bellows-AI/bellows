import type { ServiceStatus } from './board/board.js';
import {
    DEAD_SERVICE_STATES,
    Inconclusive,
    SERVICE_READY_POLL_MS,
    SERVICE_RESTART_TIMEOUT_MS,
    SERVICE_RESTART_TIMEOUT_S,
} from './runner.js';
import { pollFor, type Sleep } from './poll.js';
import type { ServiceSpec } from './services.js';
import { stepLost } from './step-control.js';

/**
 * A fleet that was started but never ran — a service listed dead, or one still not running when
 * the budget ran out. A verdict on the declared services (the loop reports it as `services`), never
 * an infrastructure refusal, which is any other error.
 */
export class ServicesNotRunning extends Error {}

/**
 * Waits until every service in `specs` is listed `running` (issue #560), re-listing every
 * SERVICE_READY_POLL_MS. Throws naming a service listed dead at once, with the platform's words for
 * it when the listing has them; once `timeoutMs` — the part of the SERVICE_RESTART_TIMEOUT_MS budget
 * the caller has left — has passed on the clock (`pollFor`), it names what
 * is still not running, or throws `Inconclusive` when the last read failed (R2-1): a listing that
 * never answered proves nothing about the services. A lost supervisor (`stepLost`) is thrown at
 * once. `signal` is the attempt's stand-down: it ends the wait at the next poll. Running is the bar
 * on purpose: `.bellows.yaml` declares no health checks.
 */
export async function awaitServicesRunning(
    specs: readonly ServiceSpec[],
    list: (deadline: number) => Promise<readonly (ServiceStatus & { reason?: string | null })[]>,
    sleep: Sleep,
    {
        timeoutMs = SERVICE_RESTART_TIMEOUT_MS,
        signal,
        after = 'the restart',
    }: { timeoutMs?: number; signal?: AbortSignal | undefined; after?: 'the restart' | 'the start' } = {}
): Promise<void> {
    let pending = specs.map(({ name }) => name);
    let readError: Error | null = null;
    const running = await pollFor<true>(
        { ms: timeoutMs, everyMs: SERVICE_READY_POLL_MS, sleep, ...(signal ? { signal } : {}), abandoned: stoodDown },
        async (deadline) => {
            readError = null;
            const listed = await list(deadline).catch((e: Error) => {
                if (stepLost(e)) throw e;
                readError = e;
                return null;
            });
            if (!listed) return;
            pending = stillPending(specs, listed, after);
            return pending.length === 0 ? true : undefined;
        }
    );
    if (running) return;
    const since = `${SERVICE_RESTART_TIMEOUT_S}s after ${after}`;
    if (readError) throw new Inconclusive(`the services could not be listed ${since}: ${(readError as Error).message}`);
    throw new ServicesNotRunning(`service ${pending.map((name) => `"${name}"`).join(', ')} not running ${since}`);
}

/**
 * What of `specs` the listing does not show running, or the throw for one it shows dead: a service
 * that crashes on every start would only burn the timeout, so it is the answer, in the platform's
 * words when the listing has them.
 */
function stillPending(
    specs: readonly ServiceSpec[],
    listed: readonly (ServiceStatus & { reason?: string | null })[],
    after: string
): string[] {
    const dead = listed.find(({ name, state }) => DEAD_SERVICE_STATES.has(state) && specs.some((s) => s.name === name));
    if (dead) {
        const words = dead.reason ? ` (${dead.reason})` : '';
        throw new ServicesNotRunning(`service "${dead.name}" ${dead.state} after ${after}${words}`);
    }
    const running = new Set(listed.filter(({ state }) => state === 'running').map(({ name }) => name));
    return specs.map(({ name }) => name).filter((name) => !running.has(name));
}

/** Ends a restart the attempt stood down from (issue #560): nothing more is created or polled. */
export function throwIfStoodDown(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw stoodDown();
}

export const stoodDown = (): Error => new Error('the restart was abandoned: the attempt stood down');
