import { supervisorName } from './docker-mailbox.js';
import type { BoardJob } from './board.js';
import type { ExecDocker } from './docker-runner-support.js';

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
