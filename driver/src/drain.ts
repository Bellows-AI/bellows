import type { Loop } from './loop/loop.js';

export interface Drain {
    /** The SIGINT/SIGTERM handler: stop claiming, then hand the runs over after `handoverMs`. */
    onSignal(): void;
    /** True once the handover started: the process then exits without waiting on runs it no longer owns. */
    handedOver(): boolean;
}

/**
 * The driver's stop signal. It stops claiming, then hands every run in flight over — their leases
 * go back as interruptions, claimable at once — before anything slower. `handoverMs` is how long
 * runs may finish in place first; `0` hands over inside the signal handler, so the release is
 * posted long before a spot node's two-minute notice runs out. A second signal exits at once.
 */
export function createDrain(deps: {
    loop: Pick<Loop, 'stop' | 'handover'>;
    reaper: { stop(): void };
    handoverMs: number;
    log: (message: string) => void;
    exit: (code: number) => void;
}): Drain {
    const { loop, reaper, handoverMs, log, exit } = deps;
    let stopping = false;
    let handedOver = false;
    const handover = (): void => {
        handedOver = true;
        void loop.handover('the driver was drained');
    };
    return {
        handedOver: () => handedOver,
        onSignal() {
            if (stopping) {
                log('second signal, exiting now — runners are left to the lease');
                exit(1);
                return;
            }
            stopping = true;
            log('draining; signal again to exit immediately');
            loop.stop();
            if (handoverMs === 0) handover();
            else setTimeout(handover, handoverMs).unref();
            reaper.stop();
        },
    };
}
