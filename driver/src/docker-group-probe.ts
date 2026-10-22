import { supervisorName } from './docker-mailbox.js';
import type { BoardJob } from './board.js';
import { boundedExec, type ExecDocker } from './docker-runner-support.js';
import type { Bound } from './poll.js';
import type { Read } from './runner.js';
import { SUPERVISOR_SERVED_LINE } from './supervisor-contract.js';

/** What one read of a group's supervisor container proves: running, over or removed, or nothing. */
export type SupervisorState = 'running' | 'gone' | 'unread';

const NO_SUCH = /No such (object|container)/i;

/**
 * Reads the supervisor container of a started group (#924). `gone` only when the daemon answered that the
 * container exited or no longer exists; a failed, timed-out or unparsable answer is `unread`, never `gone`.
 */
export async function readSupervisorState(execDocker: ExecDocker, job: BoardJob): Promise<SupervisorState> {
    try {
        const read = await execDocker(['inspect', '--format', '{{json .State}}', supervisorName(job)]);
        const state: unknown = JSON.parse(read.stdout);
        const running = (state as { Running?: unknown } | null)?.Running;
        if (running === true) return 'running';
        return running === false ? 'gone' : 'unread';
    } catch (e) {
        const said = `${(e as { stderr?: string }).stderr ?? ''}${(e as Error).message}`;
        return NO_SUCH.test(said) ? 'gone' : 'unread';
    }
}

/**
 * Whether an earlier group's supervisor can still pick up a rebind (#928), as `Runner.supervisorServing`
 * reads it: a container the daemon says is gone is `absent`, one exited has stopped, one running has stopped
 * once its log carries `SUPERVISOR_SERVED_LINE`. A failed, timed-out or unparsable answer is inconclusive.
 */
export async function supervisorServing(execDocker: ExecDocker, group: BoardJob, bound: Bound): Promise<Read<boolean>> {
    const exec = boundedExec(execDocker, bound);
    let running: unknown;
    try {
        const read = await exec(['inspect', '--format', '{{json .State}}', supervisorName(group)]);
        const state: unknown = JSON.parse(read.stdout);
        running = typeof state === 'object' && state !== null && 'Running' in state ? state.Running : undefined;
    } catch (e) {
        const said = `${(e as { stderr?: string }).stderr ?? ''}${(e as Error).message}`;
        return NO_SUCH.test(said)
            ? { kind: 'absent' }
            : { kind: 'inconclusive', reason: `inspecting the earlier supervisor: ${(e as Error).message}` };
    }
    if (running === false) return { kind: 'value', value: false };
    if (running !== true) return { kind: 'inconclusive', reason: 'the earlier supervisor state is unreadable' };
    try {
        const logs = await exec(['logs', supervisorName(group)]);
        const served = logs.stdout.split('\n').some((line) => line.trim() === SUPERVISOR_SERVED_LINE);
        return { kind: 'value', value: !served };
    } catch (e) {
        const said = `${(e as { stderr?: string }).stderr ?? ''}${(e as Error).message}`;
        return NO_SUCH.test(said)
            ? { kind: 'absent' }
            : { kind: 'inconclusive', reason: `reading the earlier supervisor log: ${(e as Error).message}` };
    }
}
