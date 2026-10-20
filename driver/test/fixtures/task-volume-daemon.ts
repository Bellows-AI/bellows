import type { ExecDocker } from '../../src/docker-runner-support.js';
import { TASK_ROOT_LABEL } from '../../src/task-volume.js';

const TASK_VOLUME = /^factory-task-([0-9a-f-]{36})-\d+$/;

/**
 * `exec` with the thread's task volume present and labelled: the answer to `volume inspect` that
 * `ensureTaskVolume` adopts, for the fake daemons that stand in for a thread past its first attempt.
 * Every other call goes to `exec`.
 */
export const withTaskVolume = <T extends ExecDocker>(exec: T): T =>
    ((args, options) => {
        const root =
            args[0] === 'volume' && args[1] === 'inspect' ? TASK_VOLUME.exec(args.at(-1) ?? '')?.[1] : undefined;
        return root ? Promise.resolve({ stdout: JSON.stringify({ [TASK_ROOT_LABEL]: root }) }) : exec(args, options);
    }) as T;
