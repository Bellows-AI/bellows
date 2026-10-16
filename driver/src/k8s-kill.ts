/**
 * What a Stop (`kill`) leaves for the polls it interrupts. Deleting a Job makes the very next
 * status read answer 404 — indistinguishable from a Job fenced away by hand unless the driver
 * remembers it did the deleting. That is an in-process fact of one driver, so it lives in module state.
 */

/** The exit code a killed run resolves with — the SIGKILL status docker's killed container answers. */
export const KILLED_EXIT_CODE = 137;

/** Thrown by a poll whose Job vanished because this driver killed it. */
export class RunnerKilled extends Error {
    constructor(jobName: string) {
        super(`the runner job ${jobName} was killed`);
    }
}

const killedRunners = new Set<string>();

/** The error for a runner Job that read 404: this driver's own kill, or one fenced away by hand. */
export function vanishedRunner(name: string): Error {
    return killedRunners.has(name) ? new RunnerKilled(name) : new Error(`the runner job ${name} no longer exists`);
}

/** Records that `kill` deleted the runner Job `name`; the poll's 404 that follows is its own doing. */
export function markKilled(name: string): void {
    killedRunners.add(name);
}

/** Forgets a kill on the runner Job `name` — a fresh run of the same job starts with a clean slate. */
export function clearKilled(name: string): void {
    killedRunners.delete(name);
}
