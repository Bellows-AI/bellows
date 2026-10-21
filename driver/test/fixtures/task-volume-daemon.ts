import type { ExecDocker } from '../../src/docker-runner-support.js';
import { TASK_MOUNT, TASK_ROOT_LABEL, taskInitScript } from '../../src/task-volume.js';

const TASK_VOLUME = /^factory-task-([0-9a-f-]{36})-\d+$/;

/**
 * `exec` with the thread's task volume present and labelled: the answers to `volume ls` and `volume inspect` that
 * `ensureTaskVolume` adopts, for the fake daemons that stand in for a thread past its first attempt.
 * The root init of the volume root is answered too, as the daemon that ran it. Every other call goes
 * to `exec`.
 */
export const withTaskVolume = <T extends ExecDocker>(exec: T): T =>
    ((args, options) => {
        if (args[0] === 'run' && args.includes(taskInitScript) && args.at(-2) === TASK_MOUNT) {
            return Promise.resolve({ stdout: '' });
        }
        // The listing by root label: the thread's one volume, generation 1.
        if (args[0] === 'volume' && args[1] === 'ls' && args[3]?.startsWith(`label=${TASK_ROOT_LABEL}=`)) {
            const root = args[3].split('=')[2];
            return Promise.resolve({ stdout: root ? `factory-task-${root}-1\n` : '' });
        }
        const root =
            args[0] === 'volume' && args[1] === 'inspect' ? TASK_VOLUME.exec(args.at(-1) ?? '')?.[1] : undefined;
        return root ? Promise.resolve({ stdout: JSON.stringify({ [TASK_ROOT_LABEL]: root }) }) : exec(args, options);
    }) as T;
