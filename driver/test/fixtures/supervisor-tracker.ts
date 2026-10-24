// Every in-process supervise() a test starts is stopped before the test's directories are removed: an
// unstopped supervisor ticks on until its 90 s orphan bound, and under isolate:false it outlives its
// file into the next one's fake clock (issue #905). Each supervisor-starting file registers
// `afterEach(stopSupervisors)` at its own top level — a fixture-level hook would not bind per file.

const STOP_BOUND_MS = 5_000;
// Captured at load: a test's fake timers must not freeze the bound.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

interface Live {
    done: Promise<unknown>;
    controller: AbortController;
    scope: object | undefined;
}

const live = new Set<Live>();

/** Register a supervisor right after `supervise()` returned its promise; pass the controller whose signal it took. */
export function trackSupervisor<T extends Promise<unknown>>(done: T, controller: AbortController, scope?: object): T {
    live.add({ done, controller, scope });
    return done;
}

/** What `supervise` takes (driver/src/scripts/supervisor.cjs): the signal is the test-only stop. */
export interface Supervisable {
    supervise(
        env: Record<string, string>,
        log: (line: string) => void,
        now?: () => number,
        stop?: AbortSignal
    ): Promise<number>;
}

/** `supervise()` with a stop wired to the tracker: the only way a test starts a supervisor in-process. */
export function superviseTracked(
    supervisor: Supervisable,
    env: Record<string, string>,
    log: (line: string) => void,
    { scope, now }: { scope?: object; now?: () => number } = {}
): Promise<number> {
    const controller = new AbortController();
    return trackSupervisor(supervisor.supervise(env, log, now, controller.signal), controller, scope);
}

/** How many tracked supervisors have not been stopped yet. */
export const liveSupervisors = (): number => live.size;

/** Stops every live supervisor; the hook form (`afterEach(stopSupervisors)`), so vitest's context argument is ignored. */
export const stopSupervisors = (): Promise<void> => stopSupervisorsOf(undefined);

/**
 * Stops each live supervisor exactly once and awaits its `done`, in real time, loudly. A `scope` stops only
 * the supervisors started under it: tests that run concurrently in one file must not stop each other's.
 */
export async function stopSupervisorsOf(scope: object | undefined): Promise<void> {
    const stopping = [...live].filter((entry) => scope === undefined || entry.scope === scope);
    for (const entry of stopping) live.delete(entry);
    for (const entry of stopping) entry.controller.abort();
    const outcomes = await Promise.all(
        stopping.map(async (entry) => {
            let timer: NodeJS.Timeout | undefined;
            const bound = new Promise<'timeout'>((resolve) => {
                timer = realSetTimeout(() => resolve('timeout'), STOP_BOUND_MS);
            });
            const settled = entry.done.then(
                () => 'settled' as const,
                () => 'settled' as const
            );
            const outcome = await Promise.race([settled, bound]);
            realClearTimeout(timer);
            return outcome;
        })
    );
    const stuck = outcomes.filter((outcome) => outcome === 'timeout');
    if (stuck.length)
        throw new Error(`${stuck.length} supervisor(s) did not settle within ${STOP_BOUND_MS} ms of the stop`);
}
