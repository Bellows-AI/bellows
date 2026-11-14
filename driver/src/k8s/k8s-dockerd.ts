import { DOCKER_HOST_ENV, type RunnerClass } from '../runner-classes.js';
import { GROUP_UP_WAIT_MS } from '../supervised-steps.js';
import { MS_PER_SECOND } from './k8s-transport.js';
import type { RunnerMount, RunnerVolume } from './k8s-podfields.js';

/**
 * The docker daemon of a docker-class task group (`RunnerClass.docker`): its names, paths and the
 * pod fields around the `dockerd` native sidecar `k8s-podspec.ts` builds. The daemon is reached
 * over a unix socket alone, in an emptyDir only the agent, the gate and `dockerd` mount — never a
 * `svc-*` member, never TCP. The start script is `scripts/dockerd-start.sh`, which spells the same
 * paths (`driver/test/scripts-dockerd-start.test.ts` pins both sides).
 */

/** The sidecar's container name: what the admission policy and the loss checks read it by. */
export const DOCKERD_CONTAINER = 'dockerd';

/** The socket's emptyDir and where agent, gate and dockerd mount it — never over `/var/run`, which would hide the image's own. */
export const DOCKER_SOCK_VOLUME = 'docker-sock';
export const DOCKER_SOCK_DIR = '/run/factory-docker';
export const DOCKER_SOCKET = `${DOCKER_SOCK_DIR}/docker.sock`;

/** The socket's group: the executor images' `node` group, which the tool uid holds (mode 0660). */
export const DOCKER_SOCK_GID = 1000;

/** The temp dir agent, gate and dockerd share at one path (TMPDIR), so a bind mount of a temp file resolves on the daemon side. */
export const DOCKER_TMP_VOLUME = 'docker-tmp';
export const DOCKER_TMP_DIR = '/run/factory-tmp';

/** The daemon's data root: memory-backed, since overlayfs cannot stack on the sandbox's overlay. */
export const DOCKER_DATA_VOLUME = 'docker-data';
export const DOCKER_DATA_ROOT = '/var/lib/docker';

/** The endpoint the agent and the gate are pointed at. */
export const DOCKER_HOST_URL = `unix://${DOCKER_SOCKET}`;

/** How often the kubelet asks the daemon whether it is up; the probe gives up only after the group's own startup bound. */
const DOCKERD_PROBE_PERIOD_SECONDS = 1;

/** The exec startupProbe on the shared socket: a later init container (the gate) starts only once it passes. */
export const dockerdStartupProbe = () => ({
    exec: { command: ['docker', '--host', DOCKER_HOST_URL, 'version'] },
    periodSeconds: DOCKERD_PROBE_PERIOD_SECONDS,
    failureThreshold: Math.ceil(GROUP_UP_WAIT_MS / MS_PER_SECOND / DOCKERD_PROBE_PERIOD_SECONDS),
});

/** What the agent and the gate carry in a docker class: the platform endpoint and the shared temp dir. */
export const dockerClientEnv = (): [string, string][] => [
    [DOCKER_HOST_ENV, DOCKER_HOST_URL],
    ['TMPDIR', DOCKER_TMP_DIR],
];

/** The agent's and the gate's mounts in a docker class: the socket and the shared temp dir. */
export const dockerClientMounts = (): RunnerMount[] => [
    { name: DOCKER_SOCK_VOLUME, mountPath: DOCKER_SOCK_DIR },
    { name: DOCKER_TMP_VOLUME, mountPath: DOCKER_TMP_DIR },
];

/** The daemon's own mounts beside the clients' (the task volume is the caller's). */
export const dockerdMounts = (): RunnerMount[] => [
    { name: DOCKER_DATA_VOLUME, mountPath: DOCKER_DATA_ROOT },
    ...dockerClientMounts(),
];

/** The three pod volumes a docker class adds: the data root sized by the class (`dockerStorage`), the temp dir, the socket. */
export const dockerVolumes = (runnerClass: RunnerClass): RunnerVolume[] => [
    {
        name: DOCKER_DATA_VOLUME,
        emptyDir: {
            medium: 'Memory',
            ...(runnerClass.dockerStorage ? { sizeLimit: runnerClass.dockerStorage } : {}),
        },
    },
    { name: DOCKER_TMP_VOLUME, emptyDir: {} },
    { name: DOCKER_SOCK_VOLUME, emptyDir: {} },
];

/** The capabilities the daemon adds over the runtime default set, and the only ones: no `drop: ALL`, which breaks it. */
export const DOCKERD_CAPS = ['NET_ADMIN', 'SYS_ADMIN', 'NET_RAW'] as const;
