import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../../src/board/board.js';
import { loadDriverConfig } from '../../src/config.js';
import {
    AGENT_CONTAINER,
    GO_MARKER,
    SUPERVISOR_STEPS_MS,
    SUPERVISOR_WINDDOWN_MS,
} from '../../src/supervisor-contract.js';
import { driverSources } from '../fixtures/driver-sources.js';
import type { K8sDeps, K8sRequest } from '../../src/k8s/k8s-transport.js';
import { POLL_MS } from '../../src/k8s/k8s-transport.js';
import { GROUP_END_WAIT_MS } from '../../src/k8s/k8s-teardown.js';
import { readVerdict } from '../../src/k8s/k8s-poll.js';
import { takeoverBoundMs } from '../../src/supervisor-plan.js';
import { runnerJobName, runnerJobSpec, secretName } from '../../src/k8s/k8s-podspec.js';
import { jobPath } from '../../src/k8s/k8s-auxspec.js';
import { GATE_GID } from '../../src/claim.js';
import { TASK_MOUNT, TASK_VOLUME, taskVolumeName } from '../../src/task-volume.js';
import {
    MASTER_PROMPT,
    job,
    SESSION,
    opencodeJob,
    spec,
    POD_NAMES,
    type PodName,
    containerView,
    gateView,
    everyPodSpec,
    namespace,
} from '../fixtures/k8s-suite.js';

/** The Job's backstop beyond the agent's budget: the drain and the report, then the hours the group serves steps. */
const WINDDOWN_S =
    (SUPERVISOR_WINDDOWN_MS +
        SUPERVISOR_STEPS_MS +
        takeoverBoundMs(loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: 'factory' }))) /
    1000;

describe('the group-end wait', () => {
    // A Foreground Job delete keeps the Job readable until the kubelet has ended its pod; a wait
    // shorter than the pod's grace period reads a slow shutdown as `held` and keeps the claim.
    it('outlasts the runner pod termination grace period by at least one poll', () => {
        const KUBERNETES_DEFAULT_GRACE_SECONDS = 30;
        for (const pod of [spec().spec.template.spec]) {
            const grace =
                (pod as { terminationGracePeriodSeconds?: number }).terminationGracePeriodSeconds ??
                KUBERNETES_DEFAULT_GRACE_SECONDS;
            expect(GROUP_END_WAIT_MS).toBeGreaterThanOrEqual(grace * 1000 + POLL_MS);
        }
    });
});

describe('the runner job spec', () => {
    it('is a batch/v1 Job named after the job id and lease token, within the label bound', () => {
        expect(spec().apiVersion).toBe('batch/v1');
        expect(spec().kind).toBe('Job');
        expect(spec().metadata.name).toBe(runnerJobName(job));
        // The apiserver stamps the Job's name onto the pod template as the `job-name` label, and
        // a label value is capped at 63 bytes — the raw `factory-job-<id>-<lease token>` is 85
        // and the create answers 422. Hashed, the name is 23; the pin is the BOUND, not today's
        // spelling, so a future name change cannot reintroduce the refusal.
        expect(spec().metadata.name.length).toBeLessThanOrEqual(63);
    });

    // The plan is pinned in runner-plan.test.ts; this is its kubernetes rendering: the CLI args as
    // the container's args (its env pairs are the literal values pinned below).
    it('runs the command as a prompt, with the same argv the docker runner passes after the image', () => {
        expect(spec().spec.template.spec.containers[0]!.args).toEqual([
            '--session-id',
            SESSION,
            '--permission-mode',
            'auto',
            '--append-system-prompt',
            MASTER_PROMPT,
            '--system-prompt-snapshot',
            'off',
            '-p',
            'fix the failing build',
        ]);
    });

    it("mounts the thread's own task volume at /task and starts at its root", () => {
        const container = spec().spec.template.spec.containers[0]!;
        expect(container.env).toContainEqual({ name: 'WORKDIR', value: TASK_MOUNT });
        expect(spec().spec.template.spec.volumes).toContainEqual({
            name: TASK_VOLUME,
            persistentVolumeClaim: { claimName: taskVolumeName(job) },
        });
        // The whole volume, with no subPath: it holds this thread's tree and nothing of any other task.
        expect(container.volumeMounts).toContainEqual({ name: TASK_VOLUME, mountPath: TASK_MOUNT });
    });

    // Issue #452: the managed settings come from the per-attempt Secret, mounted read-only and
    // 0444 over /etc/claude-code/managed-settings.json — root-owned in the pod, so the agent (uid 1000)
    // cannot rewrite the scope that outranks every other. The file, not the directory (issue #1024):
    // the image's managed skills sit beside it.
    it('mounts the rendered managed settings read-only from the attempt Secret for a claude-code runner', () => {
        const s = spec();
        expect(s.spec.template.spec.volumes).toContainEqual({
            name: 'telemetry-config',
            secret: {
                secretName: secretName(job),
                items: [{ key: 'managed-settings.json', path: 'managed-settings.json' }],
                defaultMode: 0o444,
            },
        });
        expect(s.spec.template.spec.containers[0]!.volumeMounts).toContainEqual({
            name: 'telemetry-config',
            mountPath: '/etc/claude-code/managed-settings.json',
            subPath: 'managed-settings.json',
            readOnly: true,
        });
    });

    // Issues #1016, #1021, #1023, #1024: the two uids' sharing contract lives in the image — the tool's
    // TMPDIR and compile cache, the system gitconfig, the managed skills. A volume mounted over any of
    // them, or over a directory above one, would silently retire it on this executor only.
    it('mounts nothing over the paths the cross-uid sharing contract keeps in the image', () => {
        const contract = [
            '/tmp/factory-tmp',
            '/home/factory-tool/.cache/node-compile-cache',
            '/etc/gitconfig',
            '/etc/claude-code/.claude/skills',
            '/usr/local/share/factory-skills',
        ];
        for (const pod of [spec(), runnerJobSpec(loadDriverConfig({ EXECUTOR: 'kubernetes' }), opencodeJob, null)]) {
            for (const container of pod.spec.template.spec.containers) {
                for (const { mountPath } of container.volumeMounts) {
                    const over = contract.filter((path) => path === mountPath || path.startsWith(`${mountPath}/`));
                    expect(over, `${container.name} mounts ${mountPath}`).toEqual([]);
                }
            }
        }
    });

    it('mounts the rendered otel.json read-only from the attempt Secret for an opencode runner', () => {
        const s = runnerJobSpec(loadDriverConfig({ EXECUTOR: 'kubernetes' }), opencodeJob, null);
        expect(s.spec.template.spec.volumes).toContainEqual({
            name: 'telemetry-config',
            secret: {
                secretName: secretName(opencodeJob),
                items: [{ key: 'otel.json', path: 'otel.json' }],
                defaultMode: 0o444,
            },
        });
        expect(s.spec.template.spec.containers[0]!.volumeMounts).toContainEqual({
            name: 'telemetry-config',
            mountPath: '/etc/opencode-otel/otel.json',
            subPath: 'otel.json',
            readOnly: true,
        });
    });

    // Executor parity for the task worktree (issue #35): a repo job starts in the thread's
    // worktree here exactly as the docker runner does — same WORKDIR rule, one code path on the
    // board side.
    it('starts a repo job in its task worktree', () => {
        const repoSpec = runnerJobSpec(
            loadDriverConfig({ EXECUTOR: 'kubernetes' }),
            { ...job, repo: 'Bellows-AI/bellows' },
            {
                id: SESSION,
                resume: false,
            }
        );
        expect(repoSpec.spec.template.spec.containers[0]!.env).toContainEqual({
            name: 'WORKDIR',
            value: `${TASK_MOUNT}/bellows`,
        });
    });

    it('refuses to run a repo job whose worktree path cannot be asserted', () => {
        expect(() =>
            runnerJobSpec(
                loadDriverConfig({ EXECUTOR: 'kubernetes' }),
                { ...job, repo: 'Bellows-AI/bellows', rootJobId: 'not-a-uuid' },
                {
                    id: SESSION,
                    resume: false,
                }
            )
        ).toThrow(/worktree/);
    });

    it('refuses a thread root that is not a uuid before it becomes a path', () => {
        expect(() =>
            runnerJobSpec(
                loadDriverConfig({ EXECUTOR: 'kubernetes' }),
                { ...job, rootJobId: '../../etc' },
                {
                    id: SESSION,
                    resume: false,
                }
            )
        ).toThrow(/not a uuid/);
    });

    // The id becomes the Job object's name and lands in API paths — the same interpolation the
    // docker runner guards before a `docker run`, from the same kind of board.
    it('refuses a job id that is not a uuid, rather than interpolating it', () => {
        expect(() =>
            runnerJobSpec(
                loadDriverConfig({ EXECUTOR: 'kubernetes' }),
                { ...job, id: '../../etc/passwd' },
                {
                    id: SESSION,
                    resume: false,
                }
            )
        ).toThrow(/must be a uuid/);
    });

    // The k8s form of `-e NAME`: the NAMES travel and the values live in a Secret the cluster
    // already holds. A literal `value:` would put the credential in the pod spec, which anyone who
    // can `get pods` can read — the same audience every `ps` on the host has.
    it('names credentials by secretKeyRef, never by value', () => {
        const container = spec({ RUNNER_CREDENTIALS_SECRET: 'claude-credentials' }).spec.template.spec.containers[0]!;
        expect(container.env).toContainEqual({
            name: 'CLAUDE_CODE_OAUTH_TOKEN',
            valueFrom: {
                secretKeyRef: { name: 'claude-credentials', key: 'CLAUDE_CODE_OAUTH_TOKEN', optional: true },
            },
        });
        expect(container.env).toContainEqual({
            name: 'ANTHROPIC_API_KEY',
            valueFrom: { secretKeyRef: { name: 'claude-credentials', key: 'ANTHROPIC_API_KEY', optional: true } },
        });
        // WORKDIR, the OTLP endpoint, the board URL, the transcript store and the npm notice
        // switch are the only literal values a runner env carries, none of them secrets — the
        // object of the pin above.
        expect(container.env.filter((entry) => 'value' in entry)).toEqual([
            { name: 'WORKDIR', value: TASK_MOUNT },
            { name: 'OTEL_EXPORTER_OTLP_ENDPOINT', value: 'http://collector:4318' },
            { name: 'FACTORY_STATS_URL', value: 'http://127.0.0.1:8080' },
            {
                name: 'FACTORY_TRANSCRIPT_DIR',
                value: `${TASK_MOUNT}/.factory/transcripts/${job.id}`,
            },
            { name: 'BELLOWS_SESSION_ID', value: SESSION },
            { name: 'NPM_CONFIG_UPDATE_NOTIFIER', value: 'false' },
            // The two mailbox paths the agent finds its supervisor through — paths, no credential.
            { name: 'FACTORY_CTL_IN', value: '/factory/in/agent' },
            { name: 'FACTORY_CTL_OUT', value: '/factory/out/agent' },
            { name: 'FACTORY_CTL_GO', value: GO_MARKER },
        ]);
    });

    // A default only: the claim's own value rides the Secret by reference, and the pod spec never
    // states the name a second time beside it.
    it('leaves the npm notice to a claim that names it', () => {
        const envJob: BoardJob = { ...job, env: { NPM_CONFIG_UPDATE_NOTIFIER: 'true' } };
        const env = runnerJobSpec(loadDriverConfig({ EXECUTOR: 'kubernetes' }), envJob, { id: SESSION, resume: false })
            .spec.template.spec.containers[0]!.env;
        expect(env.filter((entry) => entry.name === 'NPM_CONFIG_UPDATE_NOTIFIER')).toEqual([
            {
                name: 'NPM_CONFIG_UPDATE_NOTIFIER',
                valueFrom: { secretKeyRef: { name: secretName(envJob), key: 'NPM_CONFIG_UPDATE_NOTIFIER' } },
            },
        ]);
    });

    // Where a runner's telemetry goes. A literal value like WORKDIR — an OTLP endpoint is a path,
    // not a credential — but unlike the compose world there is no network for a pod to join that
    // would make the image's baked `collector:4318` resolve, so this process has to name the
    // collector. RUNNER_OTEL_ENDPOINT overrides the compose-collector default; the pin is that it
    // lands as the runner's own `value`, readable in the pod spec like WORKDIR is.
    it('points the runner at a collector, overriding it when configured', () => {
        const def = spec().spec.template.spec.containers[0]!;
        expect(def.env).toContainEqual({ name: 'OTEL_EXPORTER_OTLP_ENDPOINT', value: 'http://collector:4318' });
        const configured = spec({ RUNNER_OTEL_ENDPOINT: 'http://telemetry.internal:4318' }).spec.template.spec
            .containers[0]!;
        expect(configured.env).toContainEqual({
            name: 'OTEL_EXPORTER_OTLP_ENDPOINT',
            value: 'http://telemetry.internal:4318',
        });
    });

    // `RUNNER_CREDENTIALS_SECRET` forwards nothing when unset: its names never appear. What the
    // spec DOES always carry is the runner's own attempt pair — the branch-ingest credential,
    // referenced into the per-attempt Secret below (its values ride the Secret, never the spec).
    it('forwards no user-configured credentials when no secret is configured', () => {
        const container = spec().spec.template.spec.containers[0]!;
        expect(container.env).toEqual([
            { name: 'WORKDIR', value: TASK_MOUNT },
            { name: 'OTEL_EXPORTER_OTLP_ENDPOINT', value: 'http://collector:4318' },
            { name: 'FACTORY_STATS_URL', value: 'http://127.0.0.1:8080' },
            {
                name: 'RUNNER_JOB_ID',
                valueFrom: {
                    secretKeyRef: { name: `factory-job-${job.id}-${job.leaseToken}-env`, key: 'RUNNER_JOB_ID' },
                },
            },
            {
                name: 'RUNNER_LEASE_TOKEN',
                valueFrom: {
                    secretKeyRef: { name: `factory-job-${job.id}-${job.leaseToken}-env`, key: 'RUNNER_LEASE_TOKEN' },
                },
            },
            {
                name: 'FACTORY_TRANSCRIPT_DIR',
                value: `${TASK_MOUNT}/.factory/transcripts/${job.id}`,
            },
            { name: 'BELLOWS_SESSION_ID', value: SESSION },
            { name: 'NPM_CONFIG_UPDATE_NOTIFIER', value: 'false' },
            { name: 'FACTORY_CTL_IN', value: '/factory/in/agent' },
            { name: 'FACTORY_CTL_OUT', value: '/factory/out/agent' },
            { name: 'FACTORY_CTL_GO', value: GO_MARKER },
        ]);
    });

    // The claim env's VALUES never touch the pod spec — anyone who can `get pods` would read them.
    // They live in a per-attempt Secret the runner creates before the Job and reaps with it.
    it('references claim env by secretKeyRef into the per-job Secret, never by value', () => {
        const envJob: BoardJob = { ...job, env: { CORE_TOKEN: 'shh' } };
        const container = runnerJobSpec(loadDriverConfig({ EXECUTOR: 'kubernetes' }), envJob, {
            id: SESSION,
            resume: false,
        }).spec.template.spec.containers[0]!;
        // NOT optional: the driver created this exact Secret moments before the Job, under this
        // attempt's own lease token — a missing key is a bug and must fail loud
        // (CreateContainerConfigError), not start the pod silently without its env.
        expect(container.env).toContainEqual({
            name: 'CORE_TOKEN',
            valueFrom: { secretKeyRef: { name: secretName(envJob), key: 'CORE_TOKEN' } },
        });
        expect(JSON.stringify(container.env)).not.toContain('shh');
    });

    // The gate pair rides the per-attempt Secret; run-control traffic goes through the supervisor's
    // relays, so no BELLOWS_CONTROL_* name reaches the runner's env.
    it('names the gate pair by secretKeyRef into the per-job Secret', () => {
        const controlled: BoardJob = {
            ...job,
            gateEnv: {
                BELLOWS_GATE_URL: 'http://10.1.2.3:41000',
                BELLOWS_GATE_TOKEN: 'ctl-secret',
            },
        };
        const container = runnerJobSpec(loadDriverConfig({ EXECUTOR: 'kubernetes' }), controlled, {
            id: SESSION,
            resume: false,
        }).spec.template.spec.containers[0]!;
        for (const name of ['BELLOWS_GATE_URL', 'BELLOWS_GATE_TOKEN']) {
            expect(container.env).toContainEqual({
                name,
                valueFrom: { secretKeyRef: { name: secretName(controlled), key: name } },
            });
        }
        expect(JSON.stringify(container.env)).not.toContain('ctl-secret');
    });

    it('carries no claim env entries for an env-less claim', () => {
        const container = spec().spec.template.spec.containers[0]!;
        // The attempt pair names the per-attempt Secret now, always — that is the runner's own
        // credential, not claim env. What must not appear is anything MEMBER-configured.
        expect(JSON.stringify(container.env)).not.toContain('CORE_TOKEN');
        // The literal values: WORKDIR, the two URLs every runner is pointed somewhere by —
        // the collector for OTLP metrics, the board for the branch reporter's attribution
        // reports — the transcript store path and the npm notice switch, none of them
        // credentials, in a spec anyone with `get pods` can read.
        expect(container.env.filter((entry) => 'value' in entry)).toEqual([
            { name: 'WORKDIR', value: TASK_MOUNT },
            { name: 'OTEL_EXPORTER_OTLP_ENDPOINT', value: 'http://collector:4318' },
            { name: 'FACTORY_STATS_URL', value: 'http://127.0.0.1:8080' },
            {
                name: 'FACTORY_TRANSCRIPT_DIR',
                value: `${TASK_MOUNT}/.factory/transcripts/${job.id}`,
            },
            { name: 'BELLOWS_SESSION_ID', value: SESSION },
            { name: 'NPM_CONFIG_UPDATE_NOTIFIER', value: 'false' },
            { name: 'FACTORY_CTL_IN', value: '/factory/in/agent' },
            { name: 'FACTORY_CTL_OUT', value: '/factory/out/agent' },
            { name: 'FACTORY_CTL_GO', value: GO_MARKER },
        ]);
    });

    // The branch reporter posts to the board's API; the same URL the docker runner forwards as
    // `-e FACTORY_STATS_URL`, defaulted from JOB_BOARD_URL and overridable for a split topology.
    it('names the board for the branch reporter, overridable', () => {
        const container = spec().spec.template.spec.containers[0]!;
        expect(container.env).toContainEqual({ name: 'FACTORY_STATS_URL', value: 'http://127.0.0.1:8080' });
        expect(
            spec({ RUNNER_STATS_URL: 'http://stats.internal:8080' }).spec.template.spec.containers[0]!.env
        ).toContainEqual({ name: 'FACTORY_STATS_URL', value: 'http://stats.internal:8080' });
    });

    // The attempt pair is a credential — the lease token most of all — so the NAMES travel in
    // the pod spec and the VALUES ride the per-attempt Secret by reference, the same discipline
    // as every claim env entry. There is no opt-out: the pair is how the runner's branch
    // reporter authenticates at all.
    it('delivers the attempt pair by secret reference, never as a value', () => {
        const container = spec().spec.template.spec.containers[0]!;
        expect(container.env).toContainEqual({
            name: 'RUNNER_JOB_ID',
            valueFrom: { secretKeyRef: { name: secretName(job), key: 'RUNNER_JOB_ID' } },
        });
        expect(container.env).toContainEqual({
            name: 'RUNNER_LEASE_TOKEN',
            valueFrom: { secretKeyRef: { name: secretName(job), key: 'RUNNER_LEASE_TOKEN' } },
        });
        // No literal pair values in the spec: only valueFrom references.
        expect(
            container.env.filter((entry) => entry.name === 'RUNNER_JOB_ID' || entry.name === 'RUNNER_LEASE_TOKEN')
        ).toEqual(
            container.env.filter(
                (entry) =>
                    (entry.name === 'RUNNER_JOB_ID' || entry.name === 'RUNNER_LEASE_TOKEN') && 'valueFrom' in entry
            )
        );
    });

    // A failed runner pod must never be re-run by the cluster: a kubelet retry would re-send the
    // prompt and run the work twice. The board owns retries — the lease expires and the job is
    // offered again, which is visible in `attempts`.
    it('never restarts a failed runner', () => {
        expect(spec().spec.template.spec.restartPolicy).toBe('Never');
        expect(spec().spec.backoffLimit).toBe(0);
    });

    it('bounds the run with an active deadline', () => {
        // DRIVER_JOB_TIMEOUT_MS maps onto the kubelet-enforced deadline, so a runner that outlives
        // its driver still dies — the k8s form of `docker kill`. The supervisor ends the agent at the
        // budget itself; the kubelet's backstop adds the drain and the report on top.
        expect(spec({ DRIVER_JOB_TIMEOUT_MS: '45000' }).spec.activeDeadlineSeconds).toBe(45 + WINDDOWN_S);
    });

    // #829: a released group waits the takeover bound after its agent went; the backstop must not end it first.
    it.each(['60', '3600'])(
        'leaves a released group its takeover bound under the deadline at a %s s lease',
        (lease) => {
            const config = loadDriverConfig({
                EXECUTOR: 'kubernetes',
                DRIVER_JOB_TIMEOUT_MS: '45000',
                DRIVER_LEASE_SECONDS: lease,
            });
            const deadline = runnerJobSpec(config, job, { id: SESSION, resume: false }).spec.activeDeadlineSeconds ?? 0;
            expect(deadline * 1000).toBeGreaterThanOrEqual(
                45_000 + SUPERVISOR_WINDDOWN_MS + SUPERVISOR_STEPS_MS + takeoverBoundMs(config)
            );
        }
    );

    // Issue #733: environment.setup ran before the agent, inside the same run budget.
    it('takes the time environment.setup spent off the active deadline', () => {
        const config = loadDriverConfig({ EXECUTOR: 'kubernetes', DRIVER_JOB_TIMEOUT_MS: '45000' });
        const setUp = runnerJobSpec(config, { ...job, setupMs: 15_000 }, { id: SESSION, resume: false });
        expect(setUp.spec.activeDeadlineSeconds).toBe(30 + WINDDOWN_S);
    });

    it('runs exactly one pod, and reaps the object when it is done', () => {
        expect(spec().spec.completions).toBe(1);
        expect(spec().spec.parallelism).toBe(1);
        expect(spec().spec.ttlSecondsAfterFinished).toBeGreaterThan(0);
    });

    // The same labels the docker runner passes as --label: factory.job is what lets `kubectl
    // get jobs -l factory.job=<id>` find a runner that outlived its driver — and what the
    // re-claim fence sweeps by; factory.lease scopes every per-attempt operation to its own
    // attempt's objects, the same split as the docker runner's two labels.
    it('labels the pod so an orphan can be found after the driver dies', () => {
        expect(spec().spec.template.metadata.labels).toMatchObject({
            'factory.job': job.id,
            'factory.lease': job.leaseToken,
        });
        expect(spec().metadata.labels).toMatchObject({
            'factory.job': job.id,
            'factory.lease': job.leaseToken,
        });
    });

    // Every runner pod would otherwise auto-mount the driver's own ServiceAccount token — the
    // credentials that may create Jobs — into the Claude container. That is the docker socket
    // riding along with the dashboard, and it is refused here for the same reason.
    it('leaves no service account token in the runner', () => {
        expect(spec().spec.template.spec.automountServiceAccountToken).toBe(false);
    });

    /**
     * Kubernetes defaults to `Always` for an untagged or `:latest` image, which would reach past
     * the node's own local images to a registry that has never heard of `claude-executor` — the
     * docker runner's "use what the daemon has" behavior has to be stated, not assumed.
     */
    it('states the pull policy instead of letting kubernetes default to Always', () => {
        expect(spec().spec.template.spec.containers[0]!.imagePullPolicy).toBe('IfNotPresent');
        expect(spec({ RUNNER_IMAGE_PULL_POLICY: 'Always' }).spec.template.spec.containers[0]!.imagePullPolicy).toBe(
            'Always'
        );
    });

    /**
     * Issue #360: a pod with no requests is BestEffort — first evicted under node memory
     * pressure, and a zero-request pod the autoscaler never provisions capacity for. The
     * configured requests land on the container verbatim.
     */
    it('renders the configured requests and limits, so the pod is Burstable and the autoscaler can size for it', () => {
        expect(
            spec({
                RUNNER_CPU_REQUEST: '500m',
                RUNNER_MEMORY_REQUEST: '1Gi',
                RUNNER_CPU_LIMIT: '2',
                RUNNER_MEMORY_LIMIT: '4Gi',
            }).spec.template.spec.containers[0]!.resources
        ).toEqual({
            requests: { cpu: '500m', memory: '1Gi' },
            limits: { cpu: '2', memory: '4Gi' },
        });
    });

    // Limits off by default, the dashboard pod's own posture: a request only reserves, while a
    // memory limit on an agent run turns a big build into an OOM kill mid-work.
    it('renders requests only when limits are unset — the dashboard posture', () => {
        const container = spec({ RUNNER_CPU_REQUEST: '500m', RUNNER_MEMORY_REQUEST: '1Gi' }).spec.template.spec
            .containers[0]!;
        expect(container.resources).toEqual({ requests: { cpu: '500m', memory: '1Gi' } });
        expect(container.resources?.limits).toBeUndefined();
    });

    it('renders no resources block at all when none are configured — the BestEffort pod this issue came from', () => {
        expect(spec().spec.template.spec.containers[0]!.resources).toBeUndefined();
    });
});

/**
 * The task volume is ReadWriteOncePod by default: a second pod mounting it while the task pod holds
 * it sits Pending. The task pod is the one consumer while its group runs, so the driver names the
 * task claim as a volume only in the runner Job's pod spec and, once an adopted group's pod is
 * terminal, in the one-shot reader Job (`readerJobSpec`); every other read or write of the volume
 * (the live close-time readouts, the probe, the snapshot) is a supervised step.
 */
describe('no pod but the task pod mounts the task volume', () => {
    const sources = driverSources().map(([name, text]) => ({ name, text }));
    const filesWith = (needle: string): string[] =>
        sources.filter(({ text }) => text.includes(needle)).map(({ name }) => name);

    it('builds one kind of Job and no bare Pod', () => {
        expect(filesWith("kind: 'Job'")).toEqual(['k8s-podspec.ts']);
        expect(filesWith("kind: 'Pod'")).toEqual([]);
    });

    it('declares the task claim as a pod volume only in the task pod spec', () => {
        expect(filesWith('taskPodVolume(')).toEqual(['k8s-podfields.ts', 'k8s-podspec.ts']);
        expect(filesWith('persistentVolumeClaim:')).toEqual(['k8s-podfields.ts', 'task-volume.ts']);
    });
});

describe('resources on every pod the driver specs', () => {
    // Issue #360: the autoscaler sizes the whole runner fleet, not just the runner pod — an
    // unschedulable sync or gate on a right-sized node strands the run. One config, every
    // builder: the requests render on each container from the same four variables. The one Pod
    // (not Job) in the fleet, a declared service under the attempt's headless Service, is sized
    // like everything else, or it lands wherever a pod slot is free.
    const REQUESTS = { requests: { cpu: '500m', memory: '1Gi' } };
    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/bellows' };

    // The runner's pod is sized by its agent: the supervisor and the exporter beside it are small
    // scripts, and a request on each would multiply the pod's reservation by three.
    const SIDECARS: readonly PodName[] = ['the task supervisor', 'the transcript exporter'];
    // The gate sidecar is sized by GATE_* and resized in place (issue #773): its own pins below.
    const SIZED_POD_NAMES = POD_NAMES.filter((name) => !SIDECARS.includes(name) && name !== 'the gate sidecar');

    it.each(SIDECARS)('leaves %s unsized: the pod is sized by its agent', (name) => {
        const { pod } = everyPodSpec({ RUNNER_CPU_REQUEST: '500m', RUNNER_MEMORY_REQUEST: '1Gi' })[name]();
        expect(pod.containers[0]!.resources).toBeUndefined();
    });

    it.each(SIZED_POD_NAMES)('carries the same requests on %s', (name) => {
        const { pod } = everyPodSpec({ RUNNER_CPU_REQUEST: '500m', RUNNER_MEMORY_REQUEST: '1Gi' })[name]();
        expect(pod.containers[0]!.resources).toEqual(REQUESTS);
    });

    // Issue #507 and #773 (D6): a gate runs the whole suite, so it is limited by GATE_* from the
    // start, and requests the idle loop's figures while the agent runs — resized up for verify, so
    // no memory limit is ever lowered under a running suite. An unset GATE_ slot is the runner's.
    it('sizes the gate sidecar idle under the GATE_* limits while the agent keeps the runner resources', () => {
        const config = loadDriverConfig({
            EXECUTOR: 'kubernetes',
            K8S_NAMESPACE: namespace,
            RUNNER_CPU_REQUEST: '500m',
            RUNNER_MEMORY_REQUEST: '1Gi',
            RUNNER_CPU_LIMIT: '4',
            GATE_CPU_REQUEST: '2',
            GATE_MEMORY_REQUEST: '2Gi',
        });
        expect(gateView(config, job).pod.containers[0]!.resources).toEqual({
            requests: { cpu: '100m', memory: '128Mi' },
            limits: { cpu: '4' },
        });
        // The runner's pod keeps the runner's sizing, through its agent.
        const runnerPod = runnerJobSpec(config, repoJob, { id: SESSION, resume: false });
        expect(runnerPod.spec.template.spec.containers[0]!.resources).toEqual({
            requests: { cpu: '500m', memory: '1Gi' },
            limits: { cpu: '4' },
        });
    });

    it.each(SIZED_POD_NAMES)('carries no resources on %s when none are configured', (name) => {
        expect(everyPodSpec()[name]().pod.containers[0]!.resources).toBeUndefined();
    });

    // R1-6: the idle request never exceeds what the gate is configured to request or limited to.
    it('keeps the gate sidecar’s idle requests within limits set below the idle figures', () => {
        const config = loadDriverConfig({
            EXECUTOR: 'kubernetes',
            K8S_NAMESPACE: namespace,
            GATE_CPU_LIMIT: '50m',
            GATE_MEMORY_LIMIT: '64Mi',
        });
        expect(gateView(config, job).pod.containers[0]!.resources).toEqual({
            requests: { cpu: '50m', memory: '64Mi' },
            limits: { cpu: '50m', memory: '64Mi' },
        });
        const unset = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace });
        expect(gateView(unset, job).pod.containers[0]!.resources).toEqual({
            requests: { cpu: '100m', memory: '128Mi' },
        });
    });
});

// Every pod runs once and never talks to the apiserver: no restart, no service-account token.
// Every Job-backed pod is bounded by a deadline of its own, never retried, and reaped once done.
describe('the lifecycle of every pod the driver specs', () => {
    it.each(POD_NAMES)('runs %s once, without a service-account token', (name) => {
        const { pod } = everyPodSpec()[name]();
        expect(pod.restartPolicy).toBe('Never');
        expect(pod.automountServiceAccountToken).toBe(false);
    });

    it.each(POD_NAMES)('bounds %s with a deadline of its own, never retries it and reaps its pod', (name) => {
        const { job: jobObject } = everyPodSpec()[name]();
        expect(jobObject.spec.activeDeadlineSeconds).toBeGreaterThan(0);
        expect(jobObject.spec.backoffLimit).toBe(0);
        expect(jobObject.spec.ttlSecondsAfterFinished).toBeGreaterThan(0);
    });
});

/*
 * Issue #382. Every pod the driver specs runs code it did not write — the agent's commands, the
 * repository's scripts, a gate, a helper, a declared service's image. The hardening below is what
 * stands between that code and the node, and it is unconditional: there is no config knob, because
 * an operator who can turn it off is an operator who will find it off after an incident.
 *
 * The list above is hand-written and can fall behind; the source-scan test below pins that every
 * Job spec lives in `k8s-podspec.ts`. This suite pins the hardening on each pod in it.
 */
describe('the pod hardening on every pod the driver specs (#382)', () => {
    // A capability is a slice of root the kernel hands a process without asking anyone. An agent
    // run needs none of them: it reads, writes and compiles inside its own worktree. Dropping ALL
    // is what makes `CAP_NET_RAW` (ARP spoofing a neighbour pod) and `CAP_DAC_OVERRIDE` (reading
    // past the file modes on the shared claim) unavailable rather than merely unused.
    it.each(POD_NAMES)('drops every capability on %s', (name) => {
        expect(everyPodSpec()[name]().pod.containers[0]!.securityContext?.capabilities?.drop).toEqual(['ALL']);
    });

    // Without this a setuid binary inside the image re-acquires what the drop above removed, and
    // the drop becomes decoration. The two are one control; they are asserted separately because
    // a regression reaches for one at a time.
    it.each(POD_NAMES)('refuses privilege escalation on %s', (name) => {
        expect(everyPodSpec()[name]().pod.containers[0]!.securityContext?.allowPrivilegeEscalation).toBe(false);
    });

    // Issue #814: the agent starts as root to launch its tool broker, with exactly the two
    // capabilities a uid switch needs; factory-launch drops both before the CLI starts.
    it('starts the agent as root with SETUID and SETGID added, and nothing else', () => {
        expect(
            containerView(loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace }), job, AGENT_CONTAINER)
                .pod.containers[0]!.securityContext
        ).toEqual({
            allowPrivilegeEscalation: false,
            capabilities: { drop: ['ALL'], add: ['SETUID', 'SETGID'] },
            runAsUser: 0,
            runAsGroup: 0,
        });
    });

    it.each(POD_NAMES)('adds no capability to any other container of %s, nor starts one as root', (name) => {
        const { pod } = everyPodSpec()[name]();
        const spec = pod as typeof pod & { initContainers?: typeof pod.containers };
        const others = [...spec.containers, ...(spec.initContainers ?? [])].filter(
            (container) => (container as { name?: string }).name !== AGENT_CONTAINER
        );
        for (const container of others) {
            const context = container.securityContext as { capabilities?: { add?: string[] }; runAsUser?: number };
            expect(context?.capabilities?.add).toBeUndefined();
            expect(context?.runAsUser).not.toBe(0);
        }
    });

    // Pod level, not container level: seccomp is a property of the whole pod's containers, and
    // naming it once is what keeps a future sidecar from being born unfiltered. RuntimeDefault is
    // the runtime's own profile — it blocks the syscalls a container has no business making
    // (keyctl, the kernel module calls) without the per-image tuning a Localhost profile needs.
    it.each(POD_NAMES)('runs %s under the runtime default seccomp profile', (name) => {
        expect(everyPodSpec()[name]().pod.securityContext?.seccompProfile).toEqual({ type: 'RuntimeDefault' });
    });

    // The deliberate absence, pinned so a future tightening reads the reason before it lands: an
    // agent run writes its caches, its HOME and its git worktree, and a read-only root filesystem
    // fails it on the first npm install. The workspace is the writable surface by design; see
    // docs/security.md, "What the hardening does not do".
    it.each(POD_NAMES)('sets no readOnlyRootFilesystem on %s, which an agent run needs', (name) => {
        expect(everyPodSpec()[name]().pod.containers[0]!.securityContext?.readOnlyRootFilesystem).toBeUndefined();
    });

    // A declared service is the one container in the fleet whose image the driver did not build: a
    // repository author names it in `.bellows.yaml` and the cluster pulls it. It is hardened like
    // everything else (the rows above), and the pod it shares with the agent carries no opt-out.
    it('hardens a declared service sidecar like every other container, its pod carrying no opt-out', () => {
        expect(everyPodSpec()['the service sidecar']().meta.labels['factory.unhardened']).toBeUndefined();
    });

    // The gate writes the shared checkout as a fixed uid:gid, on its own container: the pod's
    // securityContext keeps the seccomp profile and the volume's group (fsGroup), for every container of the pod.
    it('runs the gate sidecar as the gate uid:gid beside its hardening, the pod keeping the seccomp profile', () => {
        const { pod } = gateView(loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace }), job);
        expect(pod.securityContext).toEqual({
            seccompProfile: { type: 'RuntimeDefault' },
            fsGroup: GATE_GID,
            fsGroupChangePolicy: 'OnRootMismatch',
        });
        expect(pod.containers[0]!.securityContext).toEqual({
            allowPrivilegeEscalation: false,
            capabilities: { drop: ['ALL'] },
            runAsUser: 1000,
            runAsGroup: 1000,
        });
    });
});

describe('readVerdict', () => {
    const depsOf = (request: K8sRequest): K8sDeps => ({
        request,
        sleep: async () => {},
        config: loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace }),
    });

    it('retries a plain-text 400 Bad Request like a 5xx and answers the eventual 2xx', async () => {
        let reads = 0;
        const request: K8sRequest = () => {
            reads += 1;
            return reads <= 2
                ? Promise.resolve({ status: 400, body: '400 Bad Request' })
                : Promise.resolve({ status: 200, body: JSON.stringify({ status: { succeeded: 1 } }) });
        };
        const response = await readVerdict(depsOf(request), jobPath(namespace, 'j'), 'reading the job j');
        expect(response.status).toBe(200);
        expect(reads).toBe(3);
    });

    it('does not retry a JSON Status 400 — the API refused, and retrying would only repeat it', async () => {
        let reads = 0;
        const request: K8sRequest = () => {
            reads += 1;
            return Promise.resolve({
                status: 400,
                body: '{"kind":"Status","status":"Failure","reason":"Invalid","message":"Job.batch is invalid"}',
            });
        };
        const response = await readVerdict(depsOf(request), jobPath(namespace, 'j'), 'reading the job j');
        expect(response.status).toBe(400);
        expect(reads).toBe(1);
    });

    it('throws with the body in the message when the malformed 400 never stops', async () => {
        const request: K8sRequest = () => Promise.resolve({ status: 400, body: '400 Bad Request' });
        await expect(readVerdict(depsOf(request), jobPath(namespace, 'j'), 'reading the job j')).rejects.toThrow(
            /answered 400 .* in a row.*400 Bad Request/s
        );
    });
});
