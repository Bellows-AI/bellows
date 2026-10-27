import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import { cpuQuantityToCores, gateAdvertiseUrlFor, loadDriverConfig, memoryQuantityToBytes } from '../src/config.js';
import { dockerArgs } from '../src/docker/docker.js';
import { runnerJobSpec } from '../src/k8s/k8s-podspec.js';
import {
    SUPERVISOR_ORPHAN_MIN_MS,
    SUPERVISOR_REBIND_GRACE_MS,
    SUPERVISOR_STEP_WAIT_MS,
} from '../src/supervisor-contract.js';
import { orphanBoundMs, supervisorLiterals, takeoverBoundMs } from '../src/supervisor-plan.js';

describe('the driver config: basics', () => {
    it('runs on defaults, so a driver next to the dashboard needs no environment at all', () => {
        const config = loadDriverConfig({});

        expect(config).toMatchObject({
            boardUrl: 'http://127.0.0.1:8080',
            // No orgId. It only ever built the runner's WORKDIR, and the board sends that path now.
            executorImages: {
                'claude-code': 'claude-executor',
                opencode: 'opencode-executor',
            },
            taskVolume: { storageClass: null, accessMode: 'ReadWriteOncePod', size: '20Gi' },
            cloneBase: 'https://github.com',
            network: null,
            concurrency: 2,
            pollMs: 5_000,
            leaseSeconds: 300,
            jobTimeoutMs: 7_200_000,
            skipPermissions: false,
        });
        expect(config.passEnv).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
    });

    it('trims the trailing slash, so a board url pastes in either form', () => {
        expect(loadDriverConfig({ JOB_BOARD_URL: 'http://dashboard:8080/' }).boardUrl).toBe('http://dashboard:8080');
    });

    it.each([
        ['JOB_BOARD_URL', { JOB_BOARD_URL: 'dashboard:8080' }],
        ['DRIVER_CONCURRENCY', { DRIVER_CONCURRENCY: '0' }],
        ['DRIVER_CONCURRENCY', { DRIVER_CONCURRENCY: '2.5' }],
        ['DRIVER_POLL_MS', { DRIVER_POLL_MS: '10' }],
        ['DRIVER_LEASE_SECONDS', { DRIVER_LEASE_SECONDS: '5' }],
        ['DRIVER_JOB_TIMEOUT_MS', { DRIVER_JOB_TIMEOUT_MS: 'soon' }],
    ])('refuses a bad %s rather than falling back to the default', (label, env) => {
        expect(() => loadDriverConfig(env)).toThrow(label);
    });

    // RUNNER_SKIP_PERMISSIONS decides whether an agent may edit and run things unsupervised. A
    // typo in it must not read as "on". RUNNER_DO_NOT_DISRUPT: node churn must not redo a
    // two-hour run (issue #362), so it opts every pod the driver specs out of voluntary
    // disruption. Off by default — an undisruptable pod pins its node for as long as the run
    // lasts, and an operator on on-demand nodes may not want that.
    it.each([
        ['RUNNER_SKIP_PERMISSIONS', 'skipPermissions'],
        ['RUNNER_DO_NOT_DISRUPT', 'runnerDoNotDisrupt'],
    ] as const)('treats only an explicit value as turning %s on', (name, field) => {
        expect(loadDriverConfig({ [name]: '1' })[field]).toBe(true);
        expect(loadDriverConfig({ [name]: '0' })[field]).toBe(false);
        expect(loadDriverConfig({ [name]: 'false' })[field]).toBe(false);
        expect(loadDriverConfig({ [name]: '' })[field]).toBe(false);
    });

    // The runner's GitHub token is the board's to mint and renew (docs/connections.md): a fixed one
    // forwarded from the driver's env would shadow the helper in the agent's git and gh.
    it.each(['GITHUB_TOKEN', 'GH_TOKEN'])('refuses %s in RUNNER_ENV', (name) => {
        expect(() => loadDriverConfig({ RUNNER_ENV: `A,${name}` })).toThrow(`RUNNER_ENV must not name ${name}`);
    });

    it('reads RUNNER_ENV as a list of names', () => {
        expect(loadDriverConfig({ RUNNER_ENV: 'A, B ,,C' }).passEnv).toEqual(['A', 'B', 'C']);
    });
});

describe('the driver config: executor and endpoints', () => {
    // The executor choice is a runner selection, not a tuning knob: docker on the host, kubernetes
    // against the API server the driver's own pod talks to. A typo in it must not read as "docker
    // is fine" and silently spawn nothing — hence a fatal, explicit enum.
    it('defaults EXECUTOR to docker', () => {
        expect(loadDriverConfig({}).executor).toBe('docker');
        expect(loadDriverConfig({ EXECUTOR: 'kubernetes' }).executor).toBe('kubernetes');
    });

    // Issue #773: the services share their group supervisor's network namespace, so no services
    // network sits beside RUNNER_NETWORK for docker to refuse a default network next to.
    it('takes a docker default RUNNER_NETWORK with services on: no services network sits beside it', () => {
        for (const network of ['bridge', 'host', 'none']) {
            expect(loadDriverConfig({ RUNNER_NETWORK: network, RUNNER_SERVICES: '1' }).network, network).toBe(network);
        }
    });

    it('refuses an unknown EXECUTOR rather than falling back to docker', () => {
        for (const executor of ['k8s', 'KUBERNETES', 'kube']) {
            expect(() => loadDriverConfig({ EXECUTOR: executor }), `"${executor}"`).toThrow(/EXECUTOR/);
        }
        // Empty means unset, as it does for every other variable here — the default, not a refusal.
        expect(loadDriverConfig({ EXECUTOR: '' }).executor).toBe('docker');
    });

    it('defaults K8S_NAMESPACE to default', () => {
        expect(loadDriverConfig({}).k8sNamespace).toBe('default');
        expect(loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: 'factory' }).k8sNamespace).toBe('factory');
    });

    // RUNNER_OTEL_ENDPOINT defaults to the compose collector exactly like the compose driver service
    // sets it, so the endpoint is always provided to the runner — a pod that keeps a baked default
    // (http://collector:4318) resolves nothing on kubernetes, and "ensure telemetry reaches the
    // collector" cannot both run every job and opt out of naming it. The override wins, for a
    // collector the compose network cannot name.
    it('defaults RUNNER_OTEL_ENDPOINT to the compose collector, overridable', () => {
        expect(loadDriverConfig({}).otelEndpoint).toBe('http://collector:4318');
        expect(loadDriverConfig({ RUNNER_OTEL_ENDPOINT: '' }).otelEndpoint).toBe('http://collector:4318');
        expect(
            loadDriverConfig({ EXECUTOR: 'kubernetes', RUNNER_OTEL_ENDPOINT: 'http://telemetry.internal:4318' })
                .otelEndpoint
        ).toBe('http://telemetry.internal:4318');
    });

    // The branch reporter posts to the board's own API. Defaulting it to JOB_BOARD_URL means a
    // compose or chart driver needs zero configuration — the runner can already reach the board,
    // which is what JOB_BOARD_URL is for. The override is for the split topology (host driver,
    // containerized runners) where only a host-gateway address reaches the API.
    it('defaults RUNNER_STATS_URL to the board url, overridable', () => {
        expect(loadDriverConfig({}).statsUrl).toBe('http://127.0.0.1:8080');
        expect(loadDriverConfig({ JOB_BOARD_URL: 'http://dashboard:8080/' }).statsUrl).toBe('http://dashboard:8080');
        expect(loadDriverConfig({ RUNNER_STATS_URL: 'http://stats.internal:8080' }).statsUrl).toBe(
            'http://stats.internal:8080'
        );
        // The reporter concatenates request paths onto this string — a trailing slash would 404
        // every report into the silence its error handling promises.
        expect(loadDriverConfig({ RUNNER_STATS_URL: 'http://stats.internal:8080/' }).statsUrl).toBe(
            'http://stats.internal:8080'
        );
        // Same scheme rule as JOB_BOARD_URL: a URL without a scheme parses as a path, and a
        // reporter pointed at a path posts nowhere, silently.
        expect(() => loadDriverConfig({ RUNNER_STATS_URL: 'stats:8080' })).toThrow(/RUNNER_STATS_URL/);
    });

    // The kubernetes executor forwards runner credentials the way the docker one forwards `-e NAME`:
    // the NAMES travel, the values live in a Secret the cluster already holds. Off unless named.
    it('leaves RUNNER_CREDENTIALS_SECRET off unless set', () => {
        expect(loadDriverConfig({}).credentialsSecret).toBeNull();
        expect(
            loadDriverConfig({ EXECUTOR: 'kubernetes', RUNNER_CREDENTIALS_SECRET: 'claude-credentials' })
                .credentialsSecret
        ).toBe('claude-credentials');
    });

    it('reads RUNNER_IMAGE_PULL_SECRETS as a trimmed name list, empty unless set', () => {
        expect(loadDriverConfig({}).imagePullSecrets).toEqual([]);
        expect(loadDriverConfig({ RUNNER_IMAGE_PULL_SECRETS: ' regcred,,mirror ' }).imagePullSecrets).toEqual([
            'regcred',
            'mirror',
        ]);
    });

    it('leaves DRIVER_HEARTBEAT_FILE off unless set', () => {
        expect(loadDriverConfig({}).heartbeatFile).toBeNull();
        expect(loadDriverConfig({ DRIVER_HEARTBEAT_FILE: '/tmp/heartbeat' }).heartbeatFile).toBe('/tmp/heartbeat');
    });

    // Issue #361: the scheduling knobs every driver-specced pod lands with. The chart forwards
    // them as JSON (`toJson`), so this loader parses JSON — and refuses anything else, because the
    // API server would reject a bad shape only at job-create time, which is attempt-burning: this
    // loader exists to move failures to startup, same as the EXECUTOR enum.
    it('reads RUNNER_NODE_SELECTOR / RUNNER_TOLERATIONS / RUNNER_AFFINITY as JSON, null unless set', () => {
        expect(loadDriverConfig({}).runnerNodeSelector).toBeNull();
        expect(loadDriverConfig({}).runnerTolerations).toBeNull();
        expect(loadDriverConfig({}).runnerAffinity).toBeNull();
        const configured = loadDriverConfig({
            EXECUTOR: 'kubernetes',
            RUNNER_NODE_SELECTOR: '{"dedicated":"factory-runners"}',
            RUNNER_TOLERATIONS:
                '[{"key":"dedicated","operator":"Equal","value":"factory-runners","effect":"NoSchedule"}]',
            RUNNER_AFFINITY:
                '{"nodeAffinity":{"requiredDuringSchedulingIgnoredDuringExecution":{"nodeSelectorTerms":[{"matchExpressions":[{"key":"dedicated","operator":"In","values":["factory-runners"]}]}]}}}',
        });
        expect(configured.runnerNodeSelector).toEqual({ dedicated: 'factory-runners' });
        expect(configured.runnerTolerations).toEqual([
            { key: 'dedicated', operator: 'Equal', value: 'factory-runners', effect: 'NoSchedule' },
        ]);
        expect(configured.runnerAffinity).toEqual({
            nodeAffinity: {
                requiredDuringSchedulingIgnoredDuringExecution: {
                    nodeSelectorTerms: [
                        { matchExpressions: [{ key: 'dedicated', operator: 'In', values: ['factory-runners'] }] },
                    ],
                },
            },
        });
    });

    it('refuses malformed or wrong-typed runner scheduling rather than falling back', () => {
        expect(() => loadDriverConfig({ RUNNER_NODE_SELECTOR: 'not json' })).toThrow(/RUNNER_NODE_SELECTOR/);
        expect(() => loadDriverConfig({ RUNNER_NODE_SELECTOR: '[]' })).toThrow(/RUNNER_NODE_SELECTOR/);
        expect(() => loadDriverConfig({ RUNNER_NODE_SELECTOR: '{"rack":3}' })).toThrow(/RUNNER_NODE_SELECTOR/);
        expect(() => loadDriverConfig({ RUNNER_TOLERATIONS: '{}' })).toThrow(/RUNNER_TOLERATIONS/);
        expect(() => loadDriverConfig({ RUNNER_TOLERATIONS: '["NoSchedule"]' })).toThrow(/RUNNER_TOLERATIONS/);
        expect(() => loadDriverConfig({ RUNNER_AFFINITY: '[]' })).toThrow(/RUNNER_AFFINITY/);
        // Empty is unset, as it is for every other variable here.
        expect(loadDriverConfig({ RUNNER_NODE_SELECTOR: '' }).runnerNodeSelector).toBeNull();
    });
});

describe('the driver config: policy and gates', () => {
    // An explicit enum, like EXECUTOR: the API server would reject a bad policy only at
    // job-create time, which is attempt-burning — this loader exists to move failures to startup.
    it('accepts only a real image pull policy', () => {
        expect(loadDriverConfig({}).imagePullPolicy).toBe('IfNotPresent');
        expect(loadDriverConfig({ RUNNER_IMAGE_PULL_POLICY: 'Always' }).imagePullPolicy).toBe('Always');
        expect(() => loadDriverConfig({ RUNNER_IMAGE_PULL_POLICY: 'ifnotpresent' })).toThrow(
            /RUNNER_IMAGE_PULL_POLICY/
        );
        expect(() => loadDriverConfig({ RUNNER_IMAGE_PULL_POLICY: 'sometimes' })).toThrow(/RUNNER_IMAGE_PULL_POLICY/);
    });

    // Issue #773: a gate container lives and ends with its task group, so there is no cooldown to
    // configure — the setting is gone, and a leftover value is read by nothing.
    it('keeps no gate environment cooldown: the gate container ends with its group', () => {
        expect('gateCooldownMs' in loadDriverConfig({})).toBe(false);
        expect('gateCooldownMs' in loadDriverConfig({ GATE_COOLDOWN_MS: '60000' })).toBe(false);
    });

    // The ad-hoc gate channel binds loopback by default — the dashboard's rule: the bind address
    // is the access control, and this endpoint runs shell commands.
    it('binds the gate server to loopback unless told otherwise, and advertises nowhere by default', () => {
        expect(loadDriverConfig({}).gateListenHost).toBe('127.0.0.1');
        expect(loadDriverConfig({ GATE_LISTEN_HOST: '0.0.0.0' }).gateListenHost).toBe('0.0.0.0');
        expect(loadDriverConfig({}).gateAdvertiseUrl).toBeNull();
        expect(loadDriverConfig({ GATE_ADVERTISE_URL: 'http://driver:9099' }).gateAdvertiseUrl).toBe(
            'http://driver:9099'
        );
    });

    // The listener binds an ephemeral port, so a configured URL without one cannot name it in
    // advance — the bound port is appended. One with a port is the operator's word and stays.
    it('appends the bound port to a portless advertise URL and leaves a ported one verbatim', () => {
        const EPHEMERAL_PORT = 44_685;
        expect(gateAdvertiseUrlFor(null, EPHEMERAL_PORT)).toBe('http://host.docker.internal:44685');
        expect(gateAdvertiseUrlFor('http://driver', EPHEMERAL_PORT)).toBe('http://driver:44685');
        expect(gateAdvertiseUrlFor('http://driver:9099', EPHEMERAL_PORT)).toBe('http://driver:9099');
        // Agents concatenate request paths onto this string, so no trailing slash may survive.
        expect(gateAdvertiseUrlFor('http://driver/', EPHEMERAL_PORT)).toBe('http://driver:44685');
        // An unparseable URL is passed through: the failure stays at the fetch, unchanged.
        expect(gateAdvertiseUrlFor('not a url', EPHEMERAL_PORT)).toBe('not a url');
    });

    // The cap on ONE gate: the runner's timeout covers the agent, this covers a gate that hangs.
    // A timed-out gate is a failed gate, not a stalled verdict.
    it('bounds each gate with a configurable timeout, ten minutes by default', () => {
        const OVERRIDE_GATE_TIMEOUT_MS = 30_000;
        expect(loadDriverConfig({}).gateTimeoutMs).toBe(600_000);
        expect(loadDriverConfig({ GATE_TIMEOUT_MS: String(OVERRIDE_GATE_TIMEOUT_MS) }).gateTimeoutMs).toBe(
            OVERRIDE_GATE_TIMEOUT_MS
        );
        expect(() => loadDriverConfig({ GATE_TIMEOUT_MS: '500' })).toThrow(/GATE_TIMEOUT_MS/);
        expect(() => loadDriverConfig({ GATE_TIMEOUT_MS: 'whenever' })).toThrow(/GATE_TIMEOUT_MS/);
    });
});

describe('the driver config: runner resources', () => {
    const USER = '44444444-4444-4444-8444-444444444444';
    const job: BoardJob = {
        id: '11111111-1111-4111-8111-111111111111',
        command: 'fix the failing build',
        rootCommand: 'fix the failing build',
        attempts: 1,
        maxAttempts: 3,
        lastAttempt: false,
        claimSeq: 1,
        leaseToken: '22222222-2222-4222-8222-222222222222',
        leaseExpiresAt: '2026-08-29T12:05:00.000Z',
        executorType: 'claude-code',
        executorRefusal: null,
        planRefusal: null,
        skillRefusal: null,
        masterPrompt: 'Factory execution context',
        resumeSessionId: null,
        followUp: false,
        ownSession: false,
        continuesInterrupted: false,
        userId: USER,
        workspacePath: `bellows/${USER}`,
    };
    const SESSION = '33333333-3333-4333-8333-333333333333';

    // Issue #360: every pod the driver specs used to carry no resources at all — BestEffort,
    // first evicted under node pressure, and invisible to the autoscaler. The four variables are
    // kubernetes quantities rendered verbatim into the pod specs (and translated for the docker
    // flags); any unset slot renders nowhere, and all four unset is the pre-issue pod.
    it('leaves the four runner resource variables unset unless set', () => {
        expect(loadDriverConfig({}).runnerResources).toEqual({
            cpuRequest: null,
            cpuLimit: null,
            memoryRequest: null,
            memoryLimit: null,
        });
        expect(
            loadDriverConfig({
                RUNNER_CPU_REQUEST: '500m',
                RUNNER_MEMORY_REQUEST: '1Gi',
                RUNNER_CPU_LIMIT: '2',
                RUNNER_MEMORY_LIMIT: '4Gi',
            }).runnerResources
        ).toEqual({
            cpuRequest: '500m',
            cpuLimit: '2',
            memoryRequest: '1Gi',
            memoryLimit: '4Gi',
        });
    });

    // The apiserver would reject a bad quantity only at job-create time, which is attempt-burning
    // — this loader exists to move failures to startup, the same reasoning as PULL_POLICIES.
    it('refuses a quantity kubernetes would reject only at job-create time, naming the variable', () => {
        expect(() => loadDriverConfig({ RUNNER_CPU_REQUEST: 'half a core' })).toThrow(/RUNNER_CPU_REQUEST/);
        expect(() => loadDriverConfig({ RUNNER_MEMORY_REQUEST: 'lots' })).toThrow(/RUNNER_MEMORY_REQUEST/);
    });

    it('refuses cpu in byte suffixes and memory in millicores', () => {
        expect(() => loadDriverConfig({ RUNNER_CPU_REQUEST: '1Gi' })).toThrow(/RUNNER_CPU_REQUEST/);
        expect(() => loadDriverConfig({ RUNNER_MEMORY_REQUEST: '500m' })).toThrow(/RUNNER_MEMORY_REQUEST/);
    });

    // Docker cannot take a fractional byte: a quantity whose byte value is not a whole number is
    // refused outright rather than silently floored.
    it('refuses a memory quantity that is not a whole number of bytes', () => {
        expect(() => loadDriverConfig({ RUNNER_MEMORY_LIMIT: '1.5Ki' })).not.toThrow();
        expect(() => loadDriverConfig({ RUNNER_MEMORY_LIMIT: '0.1Ki' })).toThrow(/RUNNER_MEMORY_LIMIT/);
    });

    // `1.001G` is exactly 1001000000 whole bytes, but binary floating-point multiplication rounds
    // Number('1.001') * 1e9 to 1000999999.9999999 — scaling must be exact, or a valid quantity
    // prevents driver startup.
    it('accepts a decimal quantity whose whole bytes floating-point multiplication would round away', () => {
        expect(memoryQuantityToBytes('1.001G')).toBe('1001000000');
        expect(() => loadDriverConfig({ RUNNER_MEMORY_LIMIT: '1.001G' })).not.toThrow();
    });

    it('still refuses a quantity genuinely fractional after exact scaling', () => {
        expect(() => memoryQuantityToBytes('1.0000000001G')).toThrow(/whole number of bytes/);
    });

    // The apiserver refuses a pod whose request exceeds its limit — at job-create, attempt-burning
    // — and docker refuses `--memory-reservation` above `--memory`; one runnerResources block
    // feeds the runner, auxiliary and service specs, so the pair is refused at startup instead,
    // naming both variables. Equal values are a valid (Guaranteed-shaped) configuration.
    it('refuses a request above its limit, naming both variables, and allows equal values', () => {
        expect(() => loadDriverConfig({ RUNNER_MEMORY_REQUEST: '2Gi', RUNNER_MEMORY_LIMIT: '1Gi' })).toThrow(
            /RUNNER_MEMORY_REQUEST.*RUNNER_MEMORY_LIMIT/
        );
        expect(() => loadDriverConfig({ RUNNER_CPU_REQUEST: '2', RUNNER_CPU_LIMIT: '500m' })).toThrow(
            /RUNNER_CPU_REQUEST.*RUNNER_CPU_LIMIT/
        );
        expect(() =>
            loadDriverConfig({
                RUNNER_CPU_REQUEST: '500m',
                RUNNER_CPU_LIMIT: '500m',
                RUNNER_MEMORY_REQUEST: '1Gi',
                RUNNER_MEMORY_LIMIT: '1Gi',
            })
        ).not.toThrow();
    });

    // Issue #507: a gate runs the whole test suite where a runner mostly waits on a model, so a
    // gate is sized on its own (GATE_*). Each unset slot falls back to the runner's, slot by slot.
    it('falls back to the runner resources slot by slot when a GATE_ variable is unset', () => {
        const runner = { RUNNER_CPU_REQUEST: '500m', RUNNER_MEMORY_REQUEST: '1Gi', RUNNER_CPU_LIMIT: '4' };
        expect(loadDriverConfig(runner).gateResources).toEqual(loadDriverConfig(runner).runnerResources);
        expect(loadDriverConfig({ ...runner, GATE_CPU_REQUEST: '2', GATE_MEMORY_LIMIT: '8Gi' }).gateResources).toEqual({
            cpuRequest: '2',
            cpuLimit: '4',
            memoryRequest: '1Gi',
            memoryLimit: '8Gi',
        });
    });

    it('refuses a bad GATE_ quantity, naming the variable', () => {
        expect(() => loadDriverConfig({ GATE_CPU_REQUEST: 'two cores' })).toThrow(/GATE_CPU_REQUEST/);
        expect(() => loadDriverConfig({ GATE_MEMORY_LIMIT: '500m' })).toThrow(/GATE_MEMORY_LIMIT/);
    });

    // The pair is checked as the gate pod will carry it — a gate request against an inherited
    // runner limit names both variables actually in play.
    it('refuses a gate request above the effective limit, naming both variables', () => {
        expect(() => loadDriverConfig({ GATE_CPU_REQUEST: '8', RUNNER_CPU_LIMIT: '4' })).toThrow(
            /GATE_CPU_REQUEST.*RUNNER_CPU_LIMIT/
        );
        expect(() => loadDriverConfig({ GATE_MEMORY_REQUEST: '4Gi', GATE_MEMORY_LIMIT: '2Gi' })).toThrow(
            /GATE_MEMORY_REQUEST.*GATE_MEMORY_LIMIT/
        );
    });

    it('renders cpu quantities as decimal cores for the docker flag', () => {
        expect(cpuQuantityToCores('500m')).toBe('0.5');
        expect(cpuQuantityToCores('250m')).toBe('0.25');
        expect(cpuQuantityToCores('2')).toBe('2');
        expect(cpuQuantityToCores('1.5')).toBe('1.5');
    });

    it('renders memory quantities as plain bytes for the docker flag', () => {
        expect(memoryQuantityToBytes('1Gi')).toBe('1073741824');
        expect(memoryQuantityToBytes('512Mi')).toBe('536870912');
        expect(memoryQuantityToBytes('1G')).toBe('1000000000');
        expect(memoryQuantityToBytes('2048')).toBe('2048');
    });

    // The done-criterion of the issue: both executors render the same numbers from the same value
    // — the k8s pod spec verbatim, the docker flags translated once, in this module.
    it('renders the same numbers on both executors from the same value', () => {
        const config = loadDriverConfig({
            EXECUTOR: 'kubernetes',
            RUNNER_CPU_LIMIT: '2',
            RUNNER_MEMORY_LIMIT: '4Gi',
            RUNNER_MEMORY_REQUEST: '1Gi',
        });
        expect(
            runnerJobSpec(config, job, { id: SESSION, resume: false }).spec.template.spec.containers[0]!.resources
        ).toEqual({
            requests: { memory: '1Gi' },
            limits: { cpu: '2', memory: '4Gi' },
        });
        // Docker flags, so before the image: past it they would be the CLI's argv.
        const argv = dockerArgs(config, job, { id: SESSION, resume: false }, { envFile: '/tmp/env-file' });
        expect(argv.slice(0, argv.indexOf('claude-executor'))).toEqual(
            expect.arrayContaining(['--cpus', '2', '--memory', '4294967296', '--memory-reservation', '1073741824'])
        );
    });
});

describe('the driver config: the orphan reaper', () => {
    // Issue #301: the periodic watcher that reaps service objects whose owning job can no longer
    // use them. Default-on: every delete is board-gated and attempt-scoped, so an idle reaper is
    // five minutes of nothing. 0 is the off switch, not a refusal.
    it('sweeps every five minutes with a ten-minute grace, both overridable, interval zero off', () => {
        expect(loadDriverConfig({}).reapIntervalMs).toBe(300_000);
        expect(loadDriverConfig({}).reapGraceMs).toBe(600_000);
        expect(loadDriverConfig({ DRIVER_REAP_INTERVAL_MS: '2000' }).reapIntervalMs).toBe(2000);
        expect(loadDriverConfig({ DRIVER_REAP_GRACE_MS: '1000' }).reapGraceMs).toBe(1000);
        expect(loadDriverConfig({ DRIVER_REAP_INTERVAL_MS: '0' }).reapIntervalMs).toBe(0);
        expect(loadDriverConfig({ DRIVER_REAP_GRACE_MS: '0' }).reapGraceMs).toBe(0);
    });

    it('defaults the task volume ttl to a day and the bound on a thread that is not whole to a week (issue #775)', () => {
        expect(loadDriverConfig({}).taskVolumeTtlMs).toBe(86_400_000);
        expect(loadDriverConfig({}).taskVolumeBoundMs).toBe(604_800_000);
        expect(loadDriverConfig({ TASK_VOLUME_TTL_MS: '3600000' }).taskVolumeTtlMs).toBe(3_600_000);
        expect(loadDriverConfig({ TASK_VOLUME_BOUND_MS: '7200000' }).taskVolumeBoundMs).toBe(7_200_000);
        expect(() => loadDriverConfig({ TASK_VOLUME_TTL_MS: '-1' })).toThrow(/TASK_VOLUME_TTL_MS/);
        expect(() => loadDriverConfig({ TASK_VOLUME_BOUND_MS: 'week' })).toThrow(/TASK_VOLUME_BOUND_MS/);
    });

    it("retries a thread's transcript re-export three times by default, a positive integer (issue #938)", () => {
        expect(loadDriverConfig({}).taskVolumeExportAttempts).toBe(3);
        expect(loadDriverConfig({ TASK_VOLUME_EXPORT_ATTEMPTS: '1' }).taskVolumeExportAttempts).toBe(1);
        expect(loadDriverConfig({ TASK_VOLUME_EXPORT_ATTEMPTS: '5' }).taskVolumeExportAttempts).toBe(5);
        for (const bad of ['0', '-1', '2.5', 'many'])
            expect(() => loadDriverConfig({ TASK_VOLUME_EXPORT_ATTEMPTS: bad })).toThrow(/TASK_VOLUME_EXPORT_ATTEMPTS/);
    });

    it('refuses a bad cadence or grace rather than falling back to the default', () => {
        expect(() => loadDriverConfig({ DRIVER_REAP_INTERVAL_MS: '-1' })).toThrow(/DRIVER_REAP_INTERVAL_MS/);
        expect(() => loadDriverConfig({ DRIVER_REAP_INTERVAL_MS: 'soon' })).toThrow(/DRIVER_REAP_INTERVAL_MS/);
        expect(() => loadDriverConfig({ DRIVER_REAP_INTERVAL_MS: '2.5' })).toThrow(/DRIVER_REAP_INTERVAL_MS/);
        expect(() => loadDriverConfig({ DRIVER_REAP_GRACE_MS: '-1' })).toThrow(/DRIVER_REAP_GRACE_MS/);
        expect(() => loadDriverConfig({ DRIVER_REAP_GRACE_MS: 'whenever' })).toThrow(/DRIVER_REAP_GRACE_MS/);
    });
});

describe('the driver config: the drain handover', () => {
    // Issue #792: how long a draining driver lets its runs finish before it hands them over —
    // under the chart's ten-minute grace, so the handover lands before the SIGKILL does.
    it('hands over after nine minutes by default, overridable, zero at once', () => {
        expect(loadDriverConfig({}).handoverMs).toBe(540_000);
        expect(loadDriverConfig({ DRIVER_HANDOVER_MS: '1000' }).handoverMs).toBe(1000);
        expect(loadDriverConfig({ DRIVER_HANDOVER_MS: '0' }).handoverMs).toBe(0);
    });

    it('refuses a bad handover delay rather than falling back to the default', () => {
        expect(() => loadDriverConfig({ DRIVER_HANDOVER_MS: '-1' })).toThrow(/DRIVER_HANDOVER_MS/);
        expect(() => loadDriverConfig({ DRIVER_HANDOVER_MS: 'later' })).toThrow(/DRIVER_HANDOVER_MS/);
    });
});

describe('the driver config: the rebind grace', () => {
    // #829: what a released group waits past its lease for a newer holder; the lanes shorten it.
    it('defaults to the supervisor contract, is overridable, and sets the takeover bound', () => {
        expect(loadDriverConfig({}).rebindGraceMs).toBe(SUPERVISOR_REBIND_GRACE_MS);
        const short = loadDriverConfig({ DRIVER_REBIND_GRACE_MS: '5000', DRIVER_LEASE_SECONDS: '10' });
        expect(short.rebindGraceMs).toBe(5000);
        expect(takeoverBoundMs(short)).toBe(15_000);
    });

    it('refuses a grace under a second or unreadable', () => {
        expect(() => loadDriverConfig({ DRIVER_REBIND_GRACE_MS: '999' })).toThrow(/DRIVER_REBIND_GRACE_MS/);
        expect(() => loadDriverConfig({ DRIVER_REBIND_GRACE_MS: 'soon' })).toThrow(/DRIVER_REBIND_GRACE_MS/);
    });
});

// #950: the kind lane runs a 15 s lease. The orphan floor and the `GET /step` long poll it is floored above are the
// lane's to lower; the production defaults stay, and a combination that lets a lost driver's group outlive the lease is refused.
describe('the driver config: the orphan floor and the step long poll (#950)', () => {
    const lane = { DRIVER_LEASE_SECONDS: '15', DRIVER_ORPHAN_MIN_MS: '10000', DRIVER_STEP_WAIT_MS: '2000' };

    it('keeps the production floor and long poll by default', () => {
        const config = loadDriverConfig({});
        expect([config.orphanMinMs, config.stepWaitMs]).toEqual([SUPERVISOR_ORPHAN_MIN_MS, SUPERVISOR_STEP_WAIT_MS]);
        expect(orphanBoundMs(loadDriverConfig({ DRIVER_LEASE_SECONDS: '120' }))).toBe(30_000);
        expect(supervisorLiterals(config, { claimSeq: 1 } as BoardJob, { exporting: false })).toContainEqual([
            'SUPERVISOR_STEP_WAIT_MS',
            String(SUPERVISOR_STEP_WAIT_MS),
        ]);
    });

    it('lowers the orphan bound to what a 15 s lease holds: the lease outlasts the bound plus one heartbeat', () => {
        const config = loadDriverConfig(lane);
        expect(orphanBoundMs(config)).toBe(10_000);
        expect(config.leaseSeconds * 1000).toBeGreaterThanOrEqual(
            orphanBoundMs(config) + (config.leaseSeconds * 1000) / 3
        );
        expect(supervisorLiterals(config, { claimSeq: 1 } as BoardJob, { exporting: false })).toContainEqual([
            'SUPERVISOR_STEP_WAIT_MS',
            '2000',
        ]);
    });

    it('refuses a lowered floor under the long poll it must outlast', () => {
        expect(() => loadDriverConfig({ ...lane, DRIVER_STEP_WAIT_MS: '9000' })).toThrow(/DRIVER_ORPHAN_MIN_MS/);
        expect(() => loadDriverConfig({ DRIVER_ORPHAN_MIN_MS: '15000' })).toThrow(/DRIVER_ORPHAN_MIN_MS/);
    });

    it('refuses a lowered floor whose orphan bound outlasts the lease less one heartbeat', () => {
        expect(() => loadDriverConfig({ ...lane, DRIVER_ORPHAN_MIN_MS: '11000' })).toThrow(/DRIVER_LEASE_SECONDS/);
        expect(() => loadDriverConfig({ ...lane, DRIVER_LEASE_SECONDS: '10' })).toThrow(/DRIVER_LEASE_SECONDS/);
    });

    it('does not recheck the lease where the floor is the production default, as the chart always sets it', () => {
        expect(loadDriverConfig({ DRIVER_LEASE_SECONDS: '30', DRIVER_ORPHAN_MIN_MS: '30000' }).orphanMinMs).toBe(
            30_000
        );
    });

    it('reads unreadable or out-of-range values as the variable that caused them', () => {
        expect(() => loadDriverConfig({ DRIVER_STEP_WAIT_MS: 'soon' })).toThrow(/DRIVER_STEP_WAIT_MS/);
        expect(() => loadDriverConfig({ DRIVER_STEP_WAIT_MS: '100' })).toThrow(/DRIVER_STEP_WAIT_MS/);
        expect(() => loadDriverConfig({ DRIVER_ORPHAN_MIN_MS: '999' })).toThrow(/DRIVER_ORPHAN_MIN_MS/);
    });
});

describe('the driver config: no service search domain (#773)', () => {
    // Declared services are the task pod's own sidecars, named on its loopback: nothing reads a
    // cluster domain into a pod, so the driver knows none and refuses none.
    it('knows no cluster domain and refuses none', () => {
        const config = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_CLUSTER_DOMAIN: 'Corp.Internal' });
        expect(config).not.toHaveProperty('k8sClusterDomain');
    });

    describe('DRIVER_METRICS_PORT (issue #831)', () => {
        it('is off unless set', () => {
            expect(loadDriverConfig({}).metricsPort).toBeNull();
            expect(loadDriverConfig({ DRIVER_METRICS_PORT: '' }).metricsPort).toBeNull();
        });

        it('takes a port, bound to the gate host', () => {
            const config = loadDriverConfig({ DRIVER_METRICS_PORT: '9464', JOB_BOARD_TOKEN: 't' });
            expect(config.metricsPort).toBe(9464);
        });

        it.each(['0', '70000', 'abc', '-1', '1.5'])('refuses %s', (port) => {
            expect(() => loadDriverConfig({ DRIVER_METRICS_PORT: port })).toThrow(/DRIVER_METRICS_PORT/);
        });

        it('refuses a port with no board token on a non-loopback host: runners can reach it and hold no token', () => {
            expect(() => loadDriverConfig({ DRIVER_METRICS_PORT: '9464', GATE_LISTEN_HOST: '0.0.0.0' })).toThrow(
                /JOB_BOARD_TOKEN/
            );
        });

        it.each(['127.0.0.1', 'localhost', '::1'])('allows a port with no token on loopback %s', (host) => {
            expect(loadDriverConfig({ DRIVER_METRICS_PORT: '9464', GATE_LISTEN_HOST: host }).metricsPort).toBe(9464);
        });

        it('allows a non-loopback host when the token is set', () => {
            const env = { DRIVER_METRICS_PORT: '9464', GATE_LISTEN_HOST: '0.0.0.0', JOB_BOARD_TOKEN: 't' };
            expect(loadDriverConfig(env).metricsPort).toBe(9464);
        });
    });
});
