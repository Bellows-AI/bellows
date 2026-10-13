/** Runtime budgets stop while an agent waits for a member's answer. */
export interface RunDeadline {
    pause(paused: boolean): void;
    clear(): void;
}

/** Start a kill timer whose remaining budget is preserved across pauses. */
export function startDeadline(ms: number, onFire: () => void): RunDeadline {
    let remaining = ms;
    let started = Date.now();
    let live = true;
    let paused = false;
    let timer: ReturnType<typeof setTimeout>;
    const arm = (): void => {
        started = Date.now();
        timer = setTimeout(
            () => {
                live = false;
                onFire();
            },
            Math.max(0, remaining)
        );
    };
    arm();
    return {
        pause(waiting) {
            if (!live || paused === waiting) return;
            paused = waiting;
            if (waiting) {
                remaining -= Date.now() - started;
                clearTimeout(timer);
            } else {
                arm();
            }
        },
        clear() {
            live = false;
            clearTimeout(timer);
        },
    };
}

/** The deadlines of runs in flight, keyed by lease token. */
export interface DeadlineRegistry {
    start(token: string, ms: number, onFire: () => void): RunDeadline;
    pause(token: string, paused: boolean): void;
}

export function createDeadlineRegistry(): DeadlineRegistry {
    const live = new Map<string, RunDeadline>();
    return {
        start(token, ms, onFire) {
            const deadline = startDeadline(ms, onFire);
            live.set(token, deadline);
            return {
                pause: (paused) => deadline.pause(paused),
                clear() {
                    deadline.clear();
                    if (live.get(token) === deadline) live.delete(token);
                },
            };
        },
        pause: (token, paused) => live.get(token)?.pause(paused),
    };
}
