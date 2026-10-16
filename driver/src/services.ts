/**
 * Auxiliary service containers (issue #6): the executors' half of the `.bellows.yaml` services.
 *
 * A repository may ask for sibling containers — a database, a cache — the way a CI pipeline
 * declares services. The BOARD resolves them: it reads the file through the GitHub API at the
 * claimed revision, validates the whole plan, and delivers the list on the claim (`BoardJob.services`),
 * so this process never opens the file. The DRIVER spawns them, because the driver is what holds the
 * docker socket the runner deliberately does not have. This module is the pure half: the argv
 * arrays the daemon will be given and the fleet bookkeeping. Lifecycle (when they start, when
 * they die) lives in docker.ts.
 *
 * Nothing here imports docker.ts, which imports this module: one direction only, so the argv
 * stays testable without a daemon and the modules cannot knot.
 */
import { JOB_LABEL, LEASE_LABEL, SERVICE_LABEL } from './labels.js';
import type { BoardJob, ServiceStatus } from './board.js';

/** One service of the claim's plan, as the board resolved it. `environment` preserves the file's order. */
export interface ServiceSpec {
    name: string;
    image: string;
    environment: { key: string; value: string }[];
    /**
     * The declared hardening opt-out (issue #382), present only when the file asked for it. A
     * service pod is hardened like every other pod the driver specs — every capability dropped —
     * and that breaks the common stock image whose entrypoint chowns its data directory as root
     * before dropping down. This restores THE IMAGE'S DEFAULT CAPABILITY SET and nothing else:
     * the escalation bit stays off and the seccomp profile stays on, because neither is what
     * broke. Absent rather than `false` when unasked, so the field's presence IS the declaration.
     */
    unhardened?: true;
    /**
     * The declared `user: "uid:gid"` the container runs as, present only when the file asked. The
     * hardened alternative to `unhardened`: a stock entrypoint that already starts as its own uid
     * skips the root-only chown and user switch, so it boots with every capability dropped.
     */
    user?: { uid: number; gid: number };
    /**
     * The TCP ports the service listens on. The board has already refused a plan whose services
     * collide on one: they share a network namespace in the task pod. Informational here — nothing
     * is published to the host.
     */
    ports?: number[];
}

/** The services the claim's plan declares: what both executors start, and nothing the driver read itself. */
export const plannedServices = (job: BoardJob): ServiceSpec[] => [...(job.services ?? [])];

/**
 * The container hardening flags (issue #382), COPIED from docker.ts rather than imported — the
 * same one-direction rule the mount string and the workspace-path regexes already follow (docker
 * imports services, never the reverse). The two spellings are pinned together in
 * driver/test/docker.test.ts, which asserts both modules' argv against one expectation, so a
 * change to one that is not made to the other fails there rather than in a container.
 */
const HARDENING_ARGS = ['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges'];

/** `no-new-privileges` only — the declared `unhardened: true` opt-out. See docker.ts for why. */
const UNHARDENED_ARGS = ['--security-opt', 'no-new-privileges'];

/**
 * What a service may be called. The name becomes a container-name suffix and a network alias —
 * the hostname the author's tests resolve — so it is a DNS label: lowercase letters, digits and
 * hyphens, one to thirty characters, no hyphen at either end.
 */
const SERVICE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;

/** What an environment variable name may look like before it is put on an argv. */
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * What an image reference may look like before it goes on an argv — the one field that names what
 * the daemon executes. An allowlist, not docker's full reference grammar: it refuses whitespace,
 * `$`, `=`, quotes and a leading `-`, which is everything that could turn the image token into
 * something other than an image. A reference this refuses but the daemon would have taken costs a
 * clear author-facing refusal; the reverse trade is flag injection waiting for an append.
 */
const IMAGE = /^[a-z0-9][a-z0-9._-]*(?::[0-9]+)?(?:\/[a-z0-9._/-]+)?(?::[a-z0-9._-]+)?(?:@sha256:[a-f0-9]{64})?$/i;

/** The state a declared service reports when the executor lists nothing for it: gone, not failed. */
export const MISSING_SERVICE_STATE = 'missing';

/**
 * The declared fleet of each attempt, by lease token, recorded once the fleet is started and
 * dropped by the attempt's teardown. Dead-service detection diffs the executor's listing against
 * it: a service removed by hand or evicted is absent from the listing, never failed in it.
 * Process-local on purpose — the probe runs in the driver that started the fleet.
 */
const declaredFleets = new Map<string, ServiceSpec[]>();

export function recordDeclaredServices(job: BoardJob, specs: ServiceSpec[]): void {
    declaredFleets.set(job.leaseToken, specs);
}

/** The attempt's recorded fleet, whole: what a pre-gate restart (issue #560) starts again. */
export function declaredServiceSpecs(job: BoardJob): ServiceSpec[] {
    return declaredFleets.get(job.leaseToken) ?? [];
}

export function forgetDeclaredServices(job: BoardJob): void {
    declaredFleets.delete(job.leaseToken);
}

/** The attempt's declared services that the executor's listing does not name. */
export function missingDeclaredServices(job: BoardJob, listed: readonly { name: string }[]): ServiceStatus[] {
    const present = new Set(listed.map((service) => service.name));
    return (declaredFleets.get(job.leaseToken) ?? [])
        .filter(({ name }) => !present.has(name))
        .map(({ name, image }) => ({ name, image, state: MISSING_SERVICE_STATE }));
}

/**
 * The per-attempt user-defined network services and the runner share. Attempt-scoped by
 * contract: the lease token is minted fresh on every claim and never repeats, so this name can
 * only ever resolve to the network the attempt that computed it created — a stale attempt
 * cannot name a replacement's, which is what makes its teardown safe without any ownership
 * gate. The one job-scoped identifier is the `factory.job` label, and the only thing allowed to
 * act on it is the re-claim fence, which runs before anything is created.
 */
export function networkName(job: BoardJob): string {
    return `factory-job-${job.id}-${job.leaseToken}-services`;
}

/** The service container's name — attempt-scoped for the same reason `networkName` is. */
export function serviceContainerName(job: BoardJob, name: string): string {
    return `factory-job-${job.id}-${job.leaseToken}-svc-${name}`;
}

/**
 * The `docker run` argv for one service: detached, on the attempt's network under the service's
 * own name as alias — which is the whole feature, `redis://cache:6379` resolving inside the job —
 * and labeled by job (what the re-claim fence searches for), by lease (what makes every teardown
 * and kill resolve to this attempt's fleet and nothing else), and by service (what makes a
 * leftover nameable in a log).
 *
 * Environment values go on the argv as `-e KEY=value`, unlike the runner's own credentials which
 * travel by name: these values were already world-readable in the author's `.bellows.yaml`, and
 * no secret of this process's own ever reaches them. There is no `-p` and no `--publish`: the
 * daemon executing this argv is root on the host, and a published port is the one step from "a
 * service for my tests" to "a listener on somebody's machine".
 */
export function serviceRunArgs(job: BoardJob, spec: ServiceSpec): string[] {
    if (!SERVICE_NAME.test(spec.name)) {
        throw new Error(`refusing to run job ${job.id}: "${spec.name}" is not a safe service name`);
    }
    if (!IMAGE.test(spec.image)) {
        throw new Error(`refusing to run job ${job.id}: "${spec.image}" is not a safe image reference`);
    }
    const args = [
        'run',
        '-d',
        // The declared opt-out reaches exactly the capability drop (issue #382): a stock image
        // whose entrypoint chowns its data directory as root needs CHOWN/DAC_OVERRIDE/FOWNER
        // back, and needs nothing else — so `no-new-privileges` is on either way.
        ...(spec.unhardened ? UNHARDENED_ARGS : HARDENING_ARGS),
        ...(spec.user ? ['--user', `${spec.user.uid}:${spec.user.gid}`] : []),
        '--name',
        serviceContainerName(job, spec.name),
        '--label',
        `${JOB_LABEL}=${job.id}`,
        '--label',
        `${LEASE_LABEL}=${job.leaseToken}`,
        '--label',
        `${SERVICE_LABEL}=${spec.name}`,
        '--network',
        networkName(job),
        '--network-alias',
        spec.name,
    ];
    for (const { key, value } of spec.environment) {
        if (!ENV_KEY.test(key)) {
            throw new Error(`refusing to run job ${job.id}: "${key}" is not a valid environment variable name`);
        }
        args.push('-e', `${key}=${value}`);
    }
    args.push(spec.image);
    return args;
}
