import { CLAIM_SEQ_MARK, COMMAND_MARK, JOB_LABEL, LEASE_LABEL, SESSION_MARK } from './labels.js';
import { createHash } from 'node:crypto';
import type { BoardJob } from './board.js';
import { executorImage, type DriverConfig } from './config.js';
import {
    GATE_GID,
    gateEnv,
    GATE_UID,
    REVIEWER_HOME,
    REVIEWER_TREE_DIR,
    REVIEWER_UID,
    GITHUB_CACHE_DIR,
    GITHUB_CACHE_SIZE,
    opencodeDbPath,
    runnerClaimEnv,
    runWorkingDir,
    transcriptDir,
    workspacePath,
} from './claim.js';
import {
    claudeTurnsScript,
    claudeExportScript,
    gateLoopArgv,
    opencodeReadoutScript,
    reviewLoopArgv,
    serviceProbeArgv,
    supervisorScript,
} from './container-scripts.js';
import { commandMark, OPENCODE_EXPORT_LIMIT, type RunSession } from './runner.js';
import { exportEnv, exportsTranscript } from './transcript-export.js';
import {
    AGENT_CONTAINER,
    EXPORTER_CONTAINER,
    GATE_CONTAINER,
    REVIEWER_CONTAINER,
    MAILBOXES,
    mailboxesOf,
    SERVICE_GENERATIONS,
    serviceAckVolume,
    serviceContainerOf,
    SUPERVISOR_CONTAINER,
} from './supervisor-contract.js';
import { assertServiceSpec, groupServices, SERVICE_ADDRESS, type ServiceSpec } from './services.js';
import {
    agentMailboxEnv,
    backstopMs,
    gateImageOf,
    supervisorControlNames,
    supervisorLiterals,
} from './supervisor-plan.js';
import { JOB_ID, MS_PER_SECOND, TTL_SECONDS } from './k8s-transport.js';
import {
    agentLaunchHardeningField,
    containerHardeningField,
    doNotDisruptField,
    gateResourcesField,
    bindingMount,
    bindingVolume,
    mailboxMount,
    reviewerResourcesField,
    mailboxVolumes,
    podHardeningField,
    resourcesField,
    runnerVolumesField,
    schedulingField,
    type ContainerSecurityContext,
    type PodResources,
    type PodSecurityContext,
    type RunnerMount,
    type RunnerVolume,
} from './k8s-podfields.js';
import { assertWorktreeResolvable, runnerPlan } from './runner-plan.js';

/**
 * The kubernetes executor's pure Job/pod spec builders — the `dockerArgs` analogue for every
 * shape this driver POSTs to the API server: the runner pod (the agent, the task supervisor, the
 * transcript exporter and the gate container), and the opencode-session / claude-turns aux
 * readouts. Everything security-relevant
 * about a runner is decided here, and pinned by tests for that reason. The transport, polling,
 * fence and runner assembly live in the sibling `k8s-*.ts` files this one has no dependency on;
 * see docs/kubernetes.md for the full map.
 */

/** One env entry for the runner container. A `valueFrom` entry names a Secret key; it never carries one. */
interface EnvVar {
    name: string;
    value?: string;
    valueFrom?: { secretKeyRef: { name: string; key: string; optional?: boolean } };
}

/** One container of the runner pod: the agent, the task supervisor, the transcript exporter, or the gate. */
export interface RunnerPodContainer {
    name: string;
    image: string;
    imagePullPolicy: string;
    /** `Always` makes an init container a native sidecar: the gate and the services, up beside the main containers. */
    restartPolicy?: 'Always';
    /** A service sidecar's generation probe (issue #773): what the kubelet restarts it on. */
    livenessProbe?: { exec: { command: string[] }; periodSeconds: number; failureThreshold: number };
    resources?: PodResources;
    /** The executor hardening (#382) — `containerHardeningField`, always present. */
    securityContext: ContainerSecurityContext;
    env: EnvVar[];
    /** The supervisor and the exporter run a script by content; the agent runs its image's entrypoint. */
    command?: string[];
    args?: string[];
    workingDir?: string;
    volumeMounts: RunnerMount[];
}

/**
 * The batch/v1 Job object. Structural on purpose: this package depends on nothing, so there is no
 * kubernetes types package to import and none is missed — the API server validates the rest.
 */
export interface RunnerJobSpec {
    apiVersion: 'batch/v1';
    kind: 'Job';
    metadata: {
        name: string;
        labels: Record<string, string>;
        annotations: Record<string, string>;
    };
    spec: {
        backoffLimit: 0;
        completions: 1;
        parallelism: 1;
        activeDeadlineSeconds: number;
        ttlSecondsAfterFinished: number;
        template: {
            metadata: {
                labels: Record<string, string>;
                /** The disruption opt-out (doNotDisruptField) — the POD's metadata, never the Job's. */
                annotations?: Record<string, string>;
            };
            spec: {
                restartPolicy: 'Never';
                automountServiceAccountToken: false;
                /** The executor hardening (#382) — `podHardeningField`, always present. */
                securityContext: PodSecurityContext;
                imagePullSecrets?: { name: string }[];
                /** The declared service names on the pod's own loopback (issue #773); absent with none. */
                hostAliases?: { ip: string; hostnames: string[] }[];
                /** The runner group's scheduling knobs — `schedulingField`, absent when unset. */
                nodeSelector?: Record<string, string>;
                tolerations?: Record<string, unknown>[];
                affinity?: Record<string, unknown>;
                /** The gate and service sidecars (issue #773), or the reclaim group's release pass (issue #814). */
                initContainers?: RunnerPodContainer[];
                /** The agent, the supervisor beside it and, for a run that exports its transcript, the exporter. */
                containers: RunnerPodContainer[];
                volumes: RunnerVolume[];
            };
        };
    };
}

/**
 * The model credentials by reference: each `passEnv` name read from the bring-your-own credentials
 * Secret. The agent container and the reviewer sidecar (issue #774) carry this and no other Secret.
 */
export function credentialsSecretEnv(config: DriverConfig): EnvVar[] {
    const env: EnvVar[] = [];
    if (config.credentialsSecret) {
        for (const name of config.passEnv) {
            env.push({
                name,
                valueFrom: {
                    secretKeyRef: {
                        name: config.credentialsSecret,
                        key: name,
                        // A bring-your-own Secret missing a key would hold the pod in
                        // CreateContainerConfigError, burning the attempt on a configuration
                        // problem. The docker runner's missing credential is an empty `-e NAME`
                        // and a warning; optional is the closest kubernetes gets to that.
                        optional: true,
                    },
                },
            });
        }
    }
    return env;
}

/**
 * The board's stacked environment plus every credential the pod carries by reference: the
 * bring-your-own credentials Secret, the claim env + minted gate credentials (the per-attempt
 * Secret `runnerJobSpec`'s caller creates), the telemetry/board URLs, and the runner's own
 * branch-ingest attempt pair. Pulled out of `runnerJobSpec` purely to keep that function's
 * complexity readable — every value here is a NAME or a literal path/URL, never a credential
 * value, the same rule the whole file is pinned on.
 */
function runnerCredentialEnv(config: DriverConfig, job: BoardJob): EnvVar[] {
    const env: EnvVar[] = credentialsSecretEnv(config);
    // The board's stacked environment plus the loop's minted gate credentials, same discipline:
    // names in the pod spec, values in the per-attempt Secret (created before the Job — see
    // create()). claimEnv has already dropped the reserved names, and the BELLOWS_* gate names
    // are disjoint from it, so a gated job whose claim resolves to nothing still gets its gate
    // credentials. NOT optional: this driver created this exact Secret moments earlier under
    // this attempt's own lease token, so a missing key is a bug and must fail loud
    // (CreateContainerConfigError) rather than start the pod silently without its env.
    const secretEnv = { ...runnerClaimEnv(job), ...(job.gateEnv ?? {}) };
    for (const name of Object.keys(secretEnv)) {
        env.push({ name, valueFrom: { secretKeyRef: { name: secretName(job), key: name } } });
    }

    // Where a runner's telemetry goes. A literal value like WORKDIR, because an OTLP endpoint is a
    // path, not a credential — and unlike docker, a pod has no network to join that would make the
    // image's baked `collector:4318` resolve, so this process names the collector its spec runs on.
    // The chart overrides it; the default names the compose collector, which is what keeps
    // telemetry flowing wherever a runtime can reach it.
    env.push({ name: 'OTEL_EXPORTER_OTLP_ENDPOINT', value: config.otelEndpoint });

    // Where the runner's branch reporter posts — the board's own URL, a literal like the OTEL
    // endpoint beside it. A URL is a path, not a credential, in a spec anyone with `get pods`
    // can read; the same default-and-override the docker runner forwards.
    env.push({ name: 'FACTORY_STATS_URL', value: config.statsUrl });

    // The runner's branch-ingest credential — the attempt it runs for, as a job id + lease
    // token pair. Both are CREDENTIALS (the lease token most of all: it is what makes the pair
    // attempt-scoped), so the names travel in the pod spec and the values ride the per-attempt
    // Secret by reference — never a value here, which anyone who can `get pods` can read.
    env.push(
        { name: 'RUNNER_JOB_ID', valueFrom: { secretKeyRef: { name: secretName(job), key: 'RUNNER_JOB_ID' } } },
        {
            name: 'RUNNER_LEASE_TOKEN',
            valueFrom: { secretKeyRef: { name: secretName(job), key: 'RUNNER_LEASE_TOKEN' } },
        }
    );
    return env;
}

/**
 * The task supervisor's container: the trusted half of the pod. It runs `scripts/supervisor.cjs` by
 * content in the executor image and mounts all four mailboxes and the member's workspace subtree —
 * the steps it runs for the driver (the sync, the probe, the publish, the helpers, the reclaim) work
 * on the task worktree — and nothing else of the member's: no telemetry config and no claim env. A
 * step's credentials arrive with the step over its authenticated channel (`supervised-steps.ts`),
 * never as this container's spec; the attempt's control pair reaches it by Secret reference, like
 * every credential in this file. It has no ServiceAccount token (the pod has none) and so no
 * Kubernetes API access. The driver keeps the lease, the claim fence and the reaper.
 */
function supervisorContainer(
    config: DriverConfig,
    job: BoardJob,
    group: {
        exporting: boolean;
        agentless: boolean;
        gated: boolean;
        reviewing: boolean;
        services: readonly ServiceSpec[];
    }
): RunnerPodContainer {
    return {
        name: SUPERVISOR_CONTAINER,
        image: executorImage(config, job.executorType),
        imagePullPolicy: config.imagePullPolicy,
        ...containerHardeningField(),
        command: ['node', '-e', supervisorScript],
        env: [
            ...supervisorLiterals(config, job, group).map(([name, value]) => ({ name, value })),
            ...supervisorControlNames(job).map((name) => ({
                name,
                valueFrom: { secretKeyRef: { name: secretName(job), key: name } },
            })),
        ],
        volumeMounts: [
            workspaceMount(config, workspacePath(job)),
            ...mailboxesOf(group.reviewing).map((box) => mailboxMount(box, 'rw')),
            bindingMount,
            ...serviceRestartMounts(group.services),
        ],
    };
}

/** The supervisor's half of the services' restart: every generation to write, every acknowledgement to read. */
const serviceRestartMounts = (services: readonly ServiceSpec[]): RunnerMount[] =>
    services.length === 0
        ? []
        : [
              { name: SERVICE_GENERATIONS.volume, mountPath: SERVICE_GENERATIONS.path },
              ...services.map(({ name }) => ({
                  name: serviceAckVolume(name),
                  mountPath: `${SERVICE_GENERATIONS.ackRoot}/${name}`,
              })),
          ];

/** How often the kubelet runs a service sidecar's generation probe, and the misses it restarts it on. */
const SERVICE_PROBE_PERIOD_SECONDS = 2;
const SERVICE_PROBE_FAILURES = 1;

/**
 * One declared service as a native sidecar of the task pod (issue #773): up beside the supervisor
 * for the whole group and reached on the pod's own loopback by its declared name (`hostAliases`).
 * Hardened like every container — the declared `user:` is its uid:gid, an image default otherwise —
 * with the claim's environment as literals: those were already world-readable in the author's
 * `.bellows.yaml`. It mounts nothing of the task: the generations read-only and its own
 * acknowledgement directory, for the liveness probe that is its restart (`serviceProbeArgv`).
 */
function serviceSidecar(config: DriverConfig, job: BoardJob, spec: ServiceSpec): RunnerPodContainer {
    assertServiceSpec(job, spec);
    const hardened = containerHardeningField().securityContext;
    return {
        name: serviceContainerOf(spec.name),
        image: spec.image,
        imagePullPolicy: config.imagePullPolicy,
        restartPolicy: 'Always',
        ...resourcesField(config),
        securityContext: {
            ...hardened,
            ...(spec.user ? { runAsNonRoot: true as const, runAsUser: spec.user.uid, runAsGroup: spec.user.gid } : {}),
        },
        env: spec.environment.map(({ key, value }) => ({ name: key, value })),
        livenessProbe: {
            exec: { command: serviceProbeArgv(spec.name) },
            periodSeconds: SERVICE_PROBE_PERIOD_SECONDS,
            failureThreshold: SERVICE_PROBE_FAILURES,
        },
        volumeMounts: [
            { name: SERVICE_GENERATIONS.volume, mountPath: SERVICE_GENERATIONS.path, readOnly: true },
            { name: serviceAckVolume(spec.name), mountPath: SERVICE_GENERATIONS.ackPath },
        ],
    };
}

/** The pod fields the declared services add: their names on loopback, and the restart's volumes. */
function servicesPodFields(services: readonly ServiceSpec[]): {
    hostAliases?: { ip: string; hostnames: string[] }[];
    volumes: RunnerVolume[];
} {
    if (services.length === 0) return { volumes: [] };
    return {
        hostAliases: [{ ip: SERVICE_ADDRESS, hostnames: services.map(({ name }) => name) }],
        volumes: [SERVICE_GENERATIONS.volume, ...services.map(({ name }) => serviceAckVolume(name))].map((name) => ({
            name,
            emptyDir: {},
        })),
    };
}

/**
 * The gate container (issue #773): the declared gate image as a native sidecar, up beside the
 * supervisor for the whole group, running the gate loop over the mailbox only the two of them mount
 * (`scripts/gate-loop.sh`). Its working directory is that mailbox: each request names its worktree,
 * which the sync may have recreated since. It writes the shared task worktree, so it writes as the
 * uid:gid every other writer on that tree uses — the executor images' `USER node` (1000:1000) — with a
 * HOME that uid can write; the declared image's own default (root, usually) would leave files the
 * uid-1000 reclaim can never remove. Its env is the gate env's own literals: the claim env and the
 * GitHub token ride each request, never this spec. It is sized idle (`gateResourcesField`) and
 * resized in place for verify.
 */
function gateSidecar(config: DriverConfig, job: BoardJob, image: string): RunnerPodContainer {
    const hardened = containerHardeningField().securityContext;
    return {
        name: GATE_CONTAINER,
        image,
        imagePullPolicy: config.imagePullPolicy,
        restartPolicy: 'Always',
        ...gateResourcesField(config),
        securityContext: { ...hardened, runAsUser: GATE_UID, runAsGroup: GATE_GID },
        command: gateLoopArgv(),
        workingDir: MAILBOXES.gate.path,
        env: gateEnv(config, job).map(([name, value]) => ({ name, value })),
        volumeMounts: [workspaceMount(config, workspacePath(job)), mailboxMount(MAILBOXES.gate, 'rw')],
    };
}

/**
 * The reviewer container (issue #774): the executor image as a native sidecar, dormant beside the
 * supervisor for the whole group, running the review loop over the review mailbox only the two of
 * them mount (`scripts/review-loop.sh`). It runs as REVIEWER_UID — not the CLI's, the tool's or the
 * gate's — so none of them can signal a review, and it holds nothing a publication needs: no
 * publish token, no credential helper, no claim env and no Secret reference but the model credentials Secret the agent also reads. Each request carries the
 * review's own environment and is gone before the review starts. Its tree is the member's subtree,
 * read-only (the shared clone and the review's worktree are in it), but for its HOME, a fixed
 * directory of that tree it mounts read-write (`REVIEWER_TREE_DIR`). Sized idle (`reviewerResourcesField`) and resized in place for a review.
 */
function reviewerSidecar(config: DriverConfig, job: BoardJob): RunnerPodContainer {
    const hardened = containerHardeningField().securityContext;
    return {
        name: REVIEWER_CONTAINER,
        image: executorImage(config, job.executorType),
        imagePullPolicy: config.imagePullPolicy,
        restartPolicy: 'Always',
        ...reviewerResourcesField(config),
        securityContext: { ...hardened, runAsUser: REVIEWER_UID, runAsGroup: GATE_GID },
        command: reviewLoopArgv(),
        workingDir: MAILBOXES.review.path,
        env: [{ name: 'HOME', value: REVIEWER_HOME }, ...credentialsSecretEnv(config)],
        volumeMounts: [
            { ...workspaceMount(config, workspacePath(job)), readOnly: true },
            mailboxMount(MAILBOXES.review, 'rw'),
            // The one place it writes: its HOME, a fixed directory of the member tree (the session
            // state a lost pod's replacement resumes from), mounted over the read-only tree above.
            { ...workspaceMount(config, `${workspacePath(job)}/${REVIEWER_TREE_DIR}`), mountPath: REVIEWER_HOME },
        ],
    };
}

/**
 * The continuous claude-code transcript exporter (`claude-export.cjs`), the third container of the
 * pod: beside the agent and under the supervisor, so a kill of the agent leaves it running to drain
 * what the agent wrote — the pod only ends once the supervisor has had it close its manifests. It
 * holds no credential: it sends through the supervisor's relay socket in their shared mailbox. It
 * mounts the member's workspace (the transcripts, its own cursor files) and the one mailbox it
 * shares with the supervisor.
 */
function exporterContainer(config: DriverConfig, job: BoardJob, startedAt: string, path: string): RunnerPodContainer {
    return {
        name: EXPORTER_CONTAINER,
        image: executorImage(config, job.executorType),
        imagePullPolicy: config.imagePullPolicy,
        ...containerHardeningField(),
        command: ['node', '-e', claudeExportScript],
        env: exportEnv(config, job, startedAt).map(([name, value]) => ({ name, value })),
        volumeMounts: [
            { name: 'workspaces', mountPath: `${config.workspaceMount}/${path}`, subPath: path },
            mailboxMount(MAILBOXES.export, 'rw'),
        ],
    };
}

/**
 * The agent's container and the volumes it needs: the member's workspace subtree and telemetry
 * config, and of the supervisor's mailboxes only the two the agent may touch.
 *
 * WORKDIR is the one literal value: a path, not a credential. Every forwarded credential is a
 * NAME only — the value lives in a Secret the cluster already holds, and `valueFrom` is what
 * keeps it out of the pod spec, which anyone who can `get pods` can read. A repo job starts in its
 * task worktree (issue #35), the same tree the docker runner's WORKDIR names (`runWorkingDir`),
 * because the close-time readout scopes the session scrape by this exact string.
 */
/** The agent's GitHub token cache volume (`GITHUB_CACHE_DIR`). */
const GITHUB_CACHE_VOLUME = 'github-cache';

function agentPart(
    config: DriverConfig,
    job: BoardJob,
    session: RunSession | null
): { container: RunnerPodContainer; volumes: RunnerVolume[] } {
    const env: EnvVar[] = [{ name: 'WORKDIR', value: runWorkingDir(config, job) }, ...runnerCredentialEnv(config, job)];
    const { mounts, volumes } = runnerVolumesField(config, job.executorType, workspacePath(job), secretName(job));

    // The argv each CLI speaks, and the executor-specific env beside it (opencode's session
    // database path, or claude-code's transcript store and session id) — decided once, for both
    // platforms, in runner-plan.ts, and RENDERED here as pod env and container args. The docker
    // runner renders the SAME plan as `-e NAME=value` plus the argv after the image name, so the
    // ENTRYPOINT of either executor image receives exactly these arguments and the platform below
    // the container is the only difference.
    const plan = runnerPlan(config, job, session);
    env.push(...plan.envPairs.map(([name, value]) => ({ name, value })));
    // The agent finds its supervisor through three mailbox paths and nothing else: no control
    // credential rides this container's env (runnerCredentialEnv never reads `supervisorEnv`), and
    // no publish token either — a publication's credential is the supervisor's step env alone.
    env.push(...agentMailboxEnv().map(([name, value]) => ({ name, value })));
    return {
        // The GitHub helper's token cache, in memory and the agent's own (docs/connections.md):
        // mounted in this container alone, never on the task volume, gone with the pod.
        volumes: [
            ...volumes,
            { name: GITHUB_CACHE_VOLUME, emptyDir: { medium: 'Memory', sizeLimit: GITHUB_CACHE_SIZE.k8s } },
        ],
        container: {
            // A constant: a container name is a DNS LABEL (63 bytes), which rules out
            // containerName(job) (85) the same way it rules the Job's own name out of the raw form.
            // The verdict and the log are read by this name: the pod holds the supervisor and the
            // exporter beside it.
            name: AGENT_CONTAINER,
            image: executorImage(config, job.executorType),
            // Stated, never defaulted: kubernetes reads a missing or :latest tag as `Always` and
            // would reach for a registry, past the image the node already holds — which is how the
            // docker runner finds it.
            imagePullPolicy: config.imagePullPolicy,
            ...resourcesField(config),
            ...agentLaunchHardeningField(),
            env,
            args: plan.cliArgs,
            // The workspace and the telemetry config, and of the supervisor only the two mailboxes
            // the agent may touch: it reads `in` (a Stop, an answer, its release) and cannot write
            // it, and it writes `out` (a question, its heartbeat). It mounts nothing of the
            // supervisor's own state or the exporter's, and no Secret carries the control
            // credential into it.
            volumeMounts: [
                ...mounts,
                mailboxMount(MAILBOXES.in, 'ro'),
                mailboxMount(MAILBOXES.out, 'rw'),
                { name: GITHUB_CACHE_VOLUME, mountPath: GITHUB_CACHE_DIR },
            ],
        },
    };
}

/**
 * The full Job object. Pure, and exported, because it is the part worth pinning in a test:
 * everything security-relevant about a runner is decided here, exactly as everything about the
 * docker runner is decided in `dockerArgs`.
 *
 * The session id is minted by the caller, not read back out of the pod, and the workspace path is
 * re-asserted here rather than trusted from the board — the same refusals the docker runner makes,
 * because the API server changing the runtime does not change who is trusted with what.
 */
export function runnerJobSpec(
    config: DriverConfig,
    job: BoardJob,
    session: RunSession | null,
    startedAt: string = new Date().toISOString()
): RunnerJobSpec {
    // The id becomes the Job object's name; assert it before it lands in the spec, the same way
    // the workspace path is asserted before it becomes a working directory.
    if (!JOB_ID.test(job.id)) {
        throw new Error(`refusing to run job ${job.id}: a job id must be a uuid`);
    }
    // The volumeMount's `subPath`: the claim's `<orgId>/<userId>` subtree, asserted before it
    // becomes part of any pod spec — by the same function, so the same refusal the docker runner
    // makes before the same value joins its `volume-subpath` (D4 of the mount-scoping design: a
    // malformed `workspacePath` is refused before any container exists, never mounted somewhere
    // unintended). Every workspaces mount this file emits carries it, which is what makes
    // "mounted broader" a shape the spec cannot express: the kubelet fails a pod whose subPath is
    // missing, loudly, rather than falling back to the whole volume.
    const path = workspacePath(job);

    // WORKDIR is the one literal value: a path, not a credential. Every forwarded credential is a
    // NAME only — the value lives in a Secret the cluster already holds, and `valueFrom` is what
    // keeps it out of the pod spec, which anyone who can `get pods` can read.
    //
    // A repo job starts in its task worktree (issue #35), the same tree the docker runner's
    // WORKDIR names; a command-only job starts at the member root, where it always did. One
    // expression with docker's (runWorkingDir), because the close-time readout scopes the session
    // scrape by this exact string — a scope key that drifted from the runner's would answer
    // nothing. Asserted from the same line dockerArgs asserts it from.
    assertWorktreeResolvable(config, job);
    // A node that launches no agent (issue #503) still gets its group — the sync, the gates' tree
    // probe and the publish are the supervisor's — but no agent container, and so no member env.
    const agentless = job.agent === false;
    const agent = agentless ? null : agentPart(config, job, session);
    const exporting = !agentless && exportsTranscript(job, session);
    // The declared gates and setup run in the group's own gate container, and the declared services
    // beside it on the pod's loopback (issue #773).
    const gateImage = gateImageOf(job);
    const reviewing = (job.reviewerProfiles?.length ?? 0) > 0;
    const services = groupServices(config, job);
    const servicesFields = servicesPodFields(services);
    // Every init container starts, in order, before the main containers, so no order spares the
    // supervisor a sidecar that never starts: the gate leads, the services follow as declared.
    const sidecars = [
        ...(gateImage ? [gateSidecar(config, job, gateImage)] : []),
        ...(reviewing ? [reviewerSidecar(config, job)] : []),
        ...services.map((service) => serviceSidecar(config, job, service)),
    ];
    const volumes: RunnerVolume[] = agent?.volumes ?? [
        { name: 'workspaces', persistentVolumeClaim: { claimName: config.workspaceVolume } },
    ];

    return {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: {
            // runnerJobName, not containerName(job): the Job's name lands on the pod template as
            // the `job-name` label, and a label value tops out at 63 bytes — the raw form is 85.
            // See runnerJobName for the full constraint.
            name: runnerJobName(job),
            // factory.job is shared by every attempt of the job: it is what `kubectl get jobs -l
            // factory.job=<id>` finds a runner that outlived its driver by, and what the re-claim
            // fence sweeps by. factory.lease is this attempt's alone — the label form of the
            // naming contract that scopes every per-attempt operation to its own objects.
            // app.kubernetes.io/instance scopes bulk cleanup to THIS release: `make stop` and a
            // shared-namespace neighbor must not delete each other's runners.
            labels: {
                [JOB_LABEL]: job.id,
                [LEASE_LABEL]: job.leaseToken,
                ...releaseLabel(config),
            },
            // What the claim that supersedes a dead driver adopts this run by (issue #792).
            annotations: {
                [CLAIM_SEQ_MARK]: String(job.claimSeq),
                ...(session ? { [SESSION_MARK]: session.id } : {}),
                [COMMAND_MARK]: commandMark(job.command),
            },
        },
        spec: {
            // A failed runner pod is never re-run by the cluster — a kubelet retry would re-send
            // the prompt and run the work twice. The board owns retries: the lease expires and the
            // job is offered again, visible in `attempts`.
            backoffLimit: 0,
            completions: 1,
            parallelism: 1,
            // DRIVER_JOB_TIMEOUT_MS maps onto the kubelet-enforced deadline, so a runner that
            // outlives its driver still dies — the k8s form of `docker kill` after the timeout.
            // The supervisor ends the agent at the budget itself; this backstop adds the drain and
            // the report, and only ends a group whose supervisor stopped doing that.
            activeDeadlineSeconds: Math.max(1, Math.round(backstopMs(config, job) / MS_PER_SECOND)),
            ttlSecondsAfterFinished: TTL_SECONDS,
            template: {
                metadata: {
                    labels: { [JOB_LABEL]: job.id, [LEASE_LABEL]: job.leaseToken, ...releaseLabel(config) },
                    ...doNotDisruptField(config),
                },
                spec: {
                    restartPolicy: 'Never',
                    // The runner gets no ServiceAccount token: automounting one would hand the
                    // Claude container the driver's own job-creating credentials — the docker
                    // socket riding along with the dashboard, refused here for the same reason.
                    automountServiceAccountToken: false,
                    // The agent's own commands run in this container (issue #382): the runtime's
                    // seccomp profile over the whole pod, every capability dropped and no
                    // escalation back out of the drop on the container below.
                    securityContext: { ...podHardeningField() },
                    ...pullSecretsField(config),
                    ...schedulingField(config),
                    ...(servicesFields.hostAliases ? { hostAliases: servicesFields.hostAliases } : {}),
                    ...(sidecars.length > 0 ? { initContainers: sidecars } : {}),
                    containers: [
                        ...(agent ? [agent.container] : []),
                        supervisorContainer(config, job, {
                            exporting,
                            agentless,
                            gated: gateImage !== null,
                            reviewing,
                            services,
                        }),
                        ...(exporting ? [exporterContainer(config, job, startedAt, path)] : []),
                    ],
                    volumes: [
                        ...volumes,
                        ...mailboxVolumes(reviewing),
                        bindingVolume(secretName(job)),
                        ...servicesFields.volumes,
                    ],
                },
            },
        },
    };
}

export const jobsPath = (namespace: string): string => `/apis/batch/v1/namespaces/${namespace}/jobs`;

/**
 * The per-attempt Secret carrying the board's resolved environment. One per ATTEMPT — the lease
 * token is part of the name — created before the Job and reaped with it: the pod spec references
 * it by `secretKeyRef`, so the values are readable only through the API server's RBAC — never off
 * the Job object itself. The token in the name is what keeps a reclaimed job's superseded worker
 * from deleting the replacement attempt's Secret: its `kill()` can only ever address the Secret
 * of the attempt it actually ran.
 *
 * Both halves are asserted before they join an API path, the same way the Job name's is.
 */
export const secretName = (job: BoardJob): string => {
    if (!JOB_ID.test(job.id)) {
        throw new Error(`refusing to address a job id that is not a uuid: ${job.id}`);
    }
    if (!JOB_ID.test(job.leaseToken)) {
        throw new Error(`refusing to address a lease token that is not a uuid: ${job.leaseToken}`);
    }
    return `factory-job-${job.id}-${job.leaseToken}-env`;
};

/**
 * The Secret object an attempt-scoped env becomes — the ONE shape for every Secret this driver
 * creates: the attempt group's claim env and control pair. Values ride in stringData, nowhere
 * else. The name is the caller's (secretName); everything else — the labels above all — is the
 * same for every group. `factory.job` is what the re-claim fence sweeps by; `factory.lease` is what scopes a
 * reap to the attempt that created it.
 */
export const secretBody = (job: BoardJob, name: string, env: Record<string, string>, owner?: JobOwner) => ({
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'Opaque',
    metadata: {
        name,
        labels: { [JOB_LABEL]: job.id, [LEASE_LABEL]: job.leaseToken },
        // The Job the Secret was created after (issue #821): the API server's garbage collector
        // deletes the Secret once that Job is gone, whatever became of the driver. No
        // `blockOwnerDeletion`, so no extra permission on the owner is needed.
        ...(owner
            ? { ownerReferences: [{ apiVersion: 'batch/v1', kind: 'Job', name: owner.name, uid: owner.uid }] }
            : {}),
    },
    stringData: env,
});

/** A created Job, as a Secret's owner: its name and the uid its create answered. */
export interface JobOwner {
    name: string;
    uid: string;
}

/** A listed runner Job, as much of it as tells a finished agent run apart. */
export interface ListedRunnerJob {
    metadata?: { name?: string };
    spec?: { suspend?: boolean; template?: { spec?: { containers?: { name?: string }[] } } };
    status?: { succeeded?: number; failed?: number };
}

/**
 * A runner Job of `pair` that runs an agent. A supervisor-only group (an agentless node, the group
 * made after an adoption) ran no agent and is no run; a Job its driver suspended (issue #821) is none.
 */
export const agentRunJob = (item: ListedRunnerJob, pair: BoardJob): boolean =>
    item.metadata?.name === runnerJobName(pair) &&
    item.spec?.suspend !== true &&
    (item.spec?.template?.spec?.containers ?? []).some((container) => container.name === AGENT_CONTAINER);

/**
 * A runner Job of `pair` that ran an agent and finished — the one shape of Job a later claim adopts
 * as it is listed (issue #792); one whose supervisor is still finalizing is waited out first (#824).
 */
export const finishedAgentRun = (item: ListedRunnerJob, pair: BoardJob): boolean =>
    agentRunJob(item, pair) && ((item.status?.succeeded ?? 0) >= 1 || (item.status?.failed ?? 0) >= 1);

/**
 * A batch Job this driver creates for its own auxiliary work — a close-time readout — as opposed
 * to a runner. Structural like `RunnerJobSpec`, and
 * deliberately a second interface rather than a widening of it: the runner's shape is pinned
 * field by field (claude argv, WORKDIR, per-name secretKeyRef), and an aux Job decides different
 * things. Sharing a type would make "the runner has no envFrom" unreadable.
 */
export interface AuxJobSpec {
    apiVersion: 'batch/v1';
    kind: 'Job';
    metadata: { name: string; labels: Record<string, string> };
    spec: {
        backoffLimit: 0;
        completions: 1;
        parallelism: 1;
        activeDeadlineSeconds: number;
        ttlSecondsAfterFinished: number;
        template: {
            metadata: {
                labels: Record<string, string>;
                /** The disruption opt-out (doNotDisruptField) — the POD's metadata, never the Job's. */
                annotations?: Record<string, string>;
            };
            spec: {
                restartPolicy: 'Never';
                automountServiceAccountToken: false;
                /** The executor hardening's pod half (#382, always present). */
                securityContext: PodSecurityContext;
                /** The runner group's scheduling knobs — `schedulingField`, absent when unset. */
                nodeSelector?: Record<string, string>;
                tolerations?: Record<string, unknown>[];
                affinity?: Record<string, unknown>;
                containers: {
                    name: string;
                    image: string;
                    imagePullPolicy: string;
                    resources?: PodResources;
                    /** The executor hardening (#382) — `containerHardeningField`, always present. */
                    securityContext: ContainerSecurityContext;
                    /** The readout script, by content. */
                    command?: string[];
                    /** A handful of literal entries (paths and bounds), never a credential. */
                    env?: EnvVar[];
                    volumeMounts: { name: string; mountPath: string; subPath: string; readOnly?: boolean }[];
                }[];
                volumes: { name: string; persistentVolumeClaim: { claimName: string } }[];
            };
        };
    };
}

/**
 * One aux Job's container — the part every builder below decides for itself. The hardening
 * (#382) is NOT part of it: `auxJobSpec` adds that to every container it builds, so a new aux Job
 * cannot be written without it the way it could if each builder had to remember.
 */
type AuxContainer = Omit<AuxJobSpec['spec']['template']['spec']['containers'][number], 'securityContext'>;

/** What one aux Job builder supplies beyond the skeleton every one of them shares. */
interface AuxJobSpecInput {
    name: string;
    deadlineSeconds: number;
    container: AuxContainer;
}

/**
 * `app.kubernetes.io/instance: <K8S_RELEASE>` on every object and pod template the driver specs.
 * On the Job it scopes bulk cleanup to THIS release (`make stop`, a shared-namespace neighbor); on
 * the pod it is what the chart's runner NetworkPolicy selects by, so one release's policy never
 * confines another release's runners. Absent when no release is configured.
 */
export function releaseLabel(config: DriverConfig): Record<string, string> {
    return config.k8sRelease ? { 'app.kubernetes.io/instance': config.k8sRelease } : {};
}

/**
 * RUNNER_IMAGE_PULL_SECRETS on a pod spec. Absent when none are configured, so the spec a
 * registry-less cluster sees is unchanged.
 */
export function pullSecretsField(config: DriverConfig): { imagePullSecrets?: { name: string }[] } {
    return config.imagePullSecrets.length > 0
        ? { imagePullSecrets: config.imagePullSecrets.map((name) => ({ name })) }
        : {};
}

/**
 * The skeleton every aux Job builder shares: `factory.job`/`factory.lease` labels (twice — Job
 * and pod template), no ServiceAccount token, `backoffLimit: 0` (the board owns retries, never
 * the kubelet), the finished-Job TTL, and the workspaces PVC as the one named volume. Each
 * builder supplies its own name, deadline and container body — command, env, envFrom,
 * workingDir, volume mounts — which is the part that actually differs and that the spec tests
 * read. `runnerJobSpec` stays separate: its shape is pinned field by field, and sharing a type
 * with the aux Jobs would make "the runner has no envFrom" unreadable.
 */
export function auxJobSpec(config: DriverConfig, job: BoardJob, input: AuxJobSpecInput): AuxJobSpec {
    const labels = { [JOB_LABEL]: job.id, [LEASE_LABEL]: job.leaseToken, ...releaseLabel(config) };
    return {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: { name: input.name, labels },
        spec: {
            backoffLimit: 0,
            completions: 1,
            parallelism: 1,
            activeDeadlineSeconds: input.deadlineSeconds,
            ttlSecondsAfterFinished: TTL_SECONDS,
            template: {
                metadata: { labels, ...doNotDisruptField(config) },
                spec: {
                    restartPolicy: 'Never',
                    automountServiceAccountToken: false,
                    ...pullSecretsField(config),
                    ...schedulingField(config),
                    securityContext: { ...podHardeningField() },
                    // One spread covers every aux Job, the same way pullSecretsField above covers
                    // their image pulls.
                    containers: [{ ...resourcesField(config), ...input.container, ...containerHardeningField() }],
                    volumes: [{ name: 'workspaces', persistentVolumeClaim: { claimName: config.workspaceVolume } }],
                },
            },
        },
    };
}

/**
 * One `workspaces` volumeMount, scoped to `subPath` — the subtree every aux Job's container
 * mounts, read-write unless the caller marks it read-only.
 */
export function workspaceMount(
    config: DriverConfig,
    subPath: string,
    readOnly?: boolean
): { name: 'workspaces'; mountPath: string; subPath: string; readOnly?: boolean } {
    return {
        name: 'workspaces',
        mountPath: `${config.workspaceMount}/${subPath}`,
        subPath,
        ...(readOnly ? { readOnly } : {}),
    };
}

/** Sixteen hex characters naming one attempt-scoped run: readable in `kubectl get jobs`, and — at 64 bits — collision-proof at any real concurrency. Eight characters (32 bits) let two simultaneous attempts collide on one Job name, and the apiserver rejects the loser with AlreadyExists. */
const HASH_HEX_LENGTH = 16;
export const hash16 = (input: string): string =>
    createHash('sha256').update(input).digest('hex').slice(0, HASH_HEX_LENGTH);

/**
 * The runner Job's name, hashed rather than `containerName(job)`'s raw
 * `<id>-<lease token>`: the apiserver carries the Job's name onto the pod template as the
 * `job-name` label, and a LABEL VALUE is capped at 63 bytes — the raw form is 85, and the
 * create answers 422. A DNS subdomain would take it; the label does not, and the label wins.
 * The hash keys on the same pair the raw form spelled out — job id and lease token — so the
 * name stays attempt-scoped: a reclaimed job's replacement attempt gets a different name, and
 * nothing a superseded attempt deletes by name can reach the winner's Job. Addressing is by label
 * everywhere it can be (the fence's sweep, the pod log); the name is only ever spoken by this
 * process, which minted it.
 */
export const runnerJobName = (job: BoardJob): string => `factory-runner-${hash16(`${job.id}|${job.leaseToken}`)}`;

/**
 * The runner's own Job name, re-asserting `job.id` is a uuid before it lands in an API path — the
 * board is not something this process trusts with a fragment of a path, copied from docker.ts,
 * which asserts the same thing before a `docker run`.
 */
export const runnerName = (job: BoardJob): string => {
    if (!JOB_ID.test(job.id)) {
        throw new Error(`refusing to address a job id that is not a uuid: ${job.id}`);
    }
    return runnerJobName(job);
};

/**
 * `<org>/<user id>` — COPIED from services.ts (which copied it from docker.ts): the path becomes
 * an env value the readout script globs under, and the board is not something this process trusts
 * with a fragment of a shell command.
 */
const WORKSPACE_PATH = /^[a-z0-9][a-z0-9_-]{0,38}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The close-time opencode session readout under kubernetes: the same script docker runs in a
 * throwaway container (opencode-readout.cjs, passed by content), as one aux Job over the PVC.
 * The database path travels as an env VALUE — the script is static, so nothing board-derived is
 * ever part of its text. The mount is READ-WRITE on purpose, unlike a plain readout:
 * opening a sqlite database whose WAL needs recovery has to write the recovery, and the run
 * that died mid-checkpoint is exactly the readout this exists for. The docker readout mounts
 * the same volume read-write for the same reason.
 */
const OPENCODE_READOUT_DEADLINE_SECONDS = 120;

export const opencodeReadoutJobName = (job: BoardJob): string =>
    `factory-ocread-${hash16(`${job.id}|${job.leaseToken}`)}`;

/**
 * The close-time claude-code turn count under kubernetes: the same script docker runs
 * (claude-turns.cjs, passed by content), as one aux Job over the PVC — the twin of the
 * opencode readout above, reading the transcript the CLI wrote onto the volume under
 * FACTORY_TRANSCRIPT_DIR while the runner lived. The mount needs no WAL recovery, but it rides
 * the same read-write shape for one reason: there is exactly one close-time readout shape per
 * executor, and two variants of it would be two shapes to keep coherent. A Job that fails or
 * overspends its deadline answers through the caller's null contract — unmeasured, never zero.
 */
export const claudeTurnsJobName = (job: BoardJob): string => `factory-cturns-${hash16(`${job.id}|${job.leaseToken}`)}`;

export function claudeTurnsJobSpec(
    config: DriverConfig,
    job: BoardJob,
    sessionId: string,
    startedAt: string
): AuxJobSpec {
    if (!JOB_ID.test(sessionId)) {
        throw new Error(`refusing to count turns for job ${job.id}: not a session id: ${sessionId}`);
    }
    return auxJobSpec(config, job, {
        name: claudeTurnsJobName(job),
        deadlineSeconds: OPENCODE_READOUT_DEADLINE_SECONDS,
        container: {
            name: 'claude-turns',
            image: executorImage(config, job.executorType),
            imagePullPolicy: config.imagePullPolicy,
            command: ['node', '-e', claudeTurnsScript],
            // Both travel as env VALUES — the script is static, so nothing board-derived is
            // ever part of its text.
            env: [
                { name: 'CLAUDE_TRANSCRIPT_DIR', value: transcriptDir(config, job) },
                { name: 'CLAUDE_SESSION_ID', value: sessionId },
                // The per-run delta bound, exactly as docker passes it.
                { name: 'RUN_STARTED_AT', value: startedAt },
            ],
            volumeMounts: [workspaceMount(config, workspacePath(job))],
        },
    });
}

export function opencodeReadoutJobSpec(config: DriverConfig, job: BoardJob, startedAt: string): AuxJobSpec {
    if (!job.workspacePath || !WORKSPACE_PATH.test(job.workspacePath)) {
        throw new Error(
            `refusing to read the opencode session database for job ${job.id}: ` +
                `the board reported no usable workspace path (${job.workspacePath ?? 'null'})`
        );
    }
    return auxJobSpec(config, job, {
        name: opencodeReadoutJobName(job),
        deadlineSeconds: OPENCODE_READOUT_DEADLINE_SECONDS,
        container: {
            name: 'opencode-readout',
            image: executorImage(config, job.executorType),
            imagePullPolicy: config.imagePullPolicy,
            command: ['node', '-e', opencodeReadoutScript],
            // Both travel as env VALUES — the script is static, so nothing board-derived is
            // ever part of its text. The directory scope is the run's own working directory
            // (the same string opencode records on the session); the database is the task's own.
            env: [
                { name: 'OPENCODE_DB', value: opencodeDbPath(config, job) },
                { name: 'OPENCODE_DIR', value: runWorkingDir(config, job) },
                // The per-run delta bound, exactly as docker passes it: a follow-up resumes the
                // root conversation, and only the cycles this run wrote may count as its turns.
                { name: 'RUN_STARTED_MS', value: String(Date.parse(startedAt)) },
                // The per-stream cap of the session export the readout prints ahead of its answer.
                { name: 'EXPORT_LIMIT_BYTES', value: String(OPENCODE_EXPORT_LIMIT) },
            ],
            volumeMounts: [workspaceMount(config, workspacePath(job))],
        },
    });
}
