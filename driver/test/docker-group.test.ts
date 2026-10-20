import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import {
    claimEnv,
    GATE_GID,
    RESERVED_ENV_NAMES,
    REVIEWER_HOME,
    REVIEWER_TREE_DIR,
    REVIEWER_UID,
} from '../src/claim.js';
import { executorImage, loadDriverConfig } from '../src/config.js';
import { dockerArgs } from '../src/docker.js';
import {
    awaitSupervisor,
    createGroup,
    ctlVolumeArgs,
    exporterCreateArgs,
    exporterName,
    gateCreateArgs,
    gateName,
    removeGroup,
    reviewerCreateArgs,
    reviewerName,
    startGroup,
    supervisorCreateArgs,
    supervisorLossOf,
} from '../src/docker-group.js';
import { ctlVolumeName, supervisorName } from '../src/docker-mailbox.js';
import { type RunnerFiles, startupRefusalOf } from '../src/docker-runner-support.js';
import { StartupRefused } from '../src/startup-cause.js';
import { gateLoopArgv, reviewLoopArgv } from '../src/container-scripts.js';
import {
    MAILBOXES,
    SUPERVISOR_BINDING_PATH,
    SUPERVISOR_CREDENTIAL_NAMES,
    SUPERVISOR_EXIT,
} from '../src/supervisor-contract.js';
import { orphanBoundMs } from '../src/supervisor-plan.js';

/*
 * The docker twin of the runner pod: the supervisor, the agent and the exporter as one container
 * group, the four mailboxes as named volumes. What is pinned is the shape the acceptance names —
 * the group holds all three, and the agent container reaches neither the supervisor's control nor
 * its credential. The pod's half is `k8s.test.ts`; the supervisor's own behavior is `supervisor.test.ts`.
 */
const USER = '44444444-4444-4444-8444-444444444444';
const SESSION = { id: '33333333-3333-4333-8333-333333333333', resume: false };
const config = loadDriverConfig({});
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
    masterPrompt:
        'Factory execution contract (factory-master-prompt/v1)\n\nFactory execution context\n- Mode: standalone',
    resumeSessionId: null,
    followUp: false,
    ownSession: false,
    continuesInterrupted: false,
    userId: USER,
    workspacePath: `bellows/${USER}`,
    gateEnv: { BELLOWS_CONTROL_URL: 'http://driver:7000', BELLOWS_CONTROL_TOKEN: 'tok-agent', OTHER: 'x' },
    supervisorEnv: {
        SUPERVISOR_CONTROL_URL: 'http://driver:7000',
        SUPERVISOR_CONTROL_TOKEN: 'tok-supervisor',
        SUPERVISOR_EXPORT_TOKEN: 'tok-export',
    },
};
const START = '2026-09-01T00:00:00Z';

const mounts = (argv: string[]): string[] => argv.filter((_arg, i) => argv[i - 1] === '--mount');
/** The same attempt, whose checkout declares a gate: its group holds a gate container. */
const gated: BoardJob = {
    ...job,
    repo: 'Bellows-AI/factory',
    gates: { image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] },
};
/** The same attempt, whose claim lists a reviewer profile (issue #774): its group holds a reviewer container. */
const reviewing: BoardJob = { ...job, reviewerProfiles: ['security'] };
const volumeOf = (box: keyof typeof MAILBOXES): string => `src=${ctlVolumeName(job, MAILBOXES[box])},`;

describe('the supervisor container', () => {
    const argv = supervisorCreateArgs(config, job, { exporting: true, agentless: false }, '/tmp/supervisor.env');

    // The supervisor runs the attempt's steps (sync, probe, publish, helpers, reclaim) as children
    // of its own container, so it mounts the member's workspace — only the member's own subtree.
    it('mounts every mailbox and the member’s own workspace subtree, nothing broader', () => {
        const mounted = mounts(argv);
        expect(mounted).toHaveLength(6);
        for (const box of ['in', 'out', 'export', 'supervisor', 'gate'] as const) {
            expect(mounted.some((mount) => mount.includes(volumeOf(box)))).toBe(true);
        }
        // The review mailbox is the reviewer container's and the supervisor's alone (issue #774).
        expect(mounted.some((mount) => mount.includes(volumeOf('review')))).toBe(false);
        const workspace = mounted.filter((mount) => mount.includes('workspaces'));
        expect(workspace).toHaveLength(1);
        expect(workspace[0]).toContain(`volume-subpath=bellows/${USER}`);
    });

    it('mounts the review mailbox too, and is told of the reviewer, when the claim lists reviewer profiles', () => {
        const withReviewer = supervisorCreateArgs(
            config,
            reviewing,
            { exporting: true, agentless: false, reviewing: true },
            '/tmp/supervisor.env'
        );
        expect(mounts(withReviewer)).toHaveLength(7);
        expect(mounts(withReviewer).some((mount) => mount.includes(volumeOf('review')))).toBe(true);
        expect(withReviewer).toContain('SUPERVISOR_REVIEWER=1');
        expect(argv).not.toContain('SUPERVISOR_REVIEWER=1');
    });

    it('is told the orphan bound the lease allows, as the exporter is its drain give-up', () => {
        const bound = orphanBoundMs(config);
        expect(argv).toContain(`SUPERVISOR_ORPHAN_MS=${bound}`);
        const exporter = exporterCreateArgs(config, job, START, '/tmp/export.env');
        expect(exporter).toContain(`EXPORT_DRAIN_GIVEUP_MS=${bound}`);
    });

    it('is told its claim and where a newer holder names itself, which the control pair is not', () => {
        expect(argv).toContain(`SUPERVISOR_CLAIM_SEQ=${job.claimSeq}`);
        expect(argv).toContain(`SUPERVISOR_BINDING_FILE=${SUPERVISOR_BINDING_PATH}`);
    });

    it('does not tell a reclaim group its claim or the binding: it follows no newer holder', () => {
        const reclaiming = supervisorCreateArgs(
            config,
            reviewing,
            { exporting: false, agentless: true, reclaim: true },
            '/tmp/supervisor.env'
        );
        expect(reclaiming.filter((arg) => /^SUPERVISOR_(CLAIM_SEQ|BINDING_FILE)=/.test(arg))).toEqual([]);
    });

    it('takes its control pair by env file, never by argv', () => {
        expect(argv).toContain('--env-file');
        expect(argv.join(' ')).not.toMatch(/tok-supervisor|tok-agent/);
    });

    it('is hardened and labelled for the fence like every container of the run', () => {
        expect(argv).toEqual(expect.arrayContaining(['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges']));
        expect(argv).toEqual(expect.arrayContaining(['--name', supervisorName(job)]));
        expect(argv).toEqual(expect.arrayContaining(['--label', `factory.lease=${job.leaseToken}`]));
    });

    // Issue #773: the supervisor holds the group's network namespace — on RUNNER_NETWORK, the
    // driver's name mapped — and its hosts file names every declared service on loopback, which
    // every container of the group shares (docker refuses --add-host on a container-mode network).
    it('holds the group’s network: RUNNER_NETWORK, the driver’s name, and each declared service on loopback', () => {
        const services = [
            { name: 'db', image: 'postgres:17', environment: [] },
            { name: 'cache', image: 'redis', environment: [] },
        ];
        const networked = loadDriverConfig({ RUNNER_NETWORK: 'factory-ai_default' });
        const line = supervisorCreateArgs(
            networked,
            { ...job, services },
            { exporting: false, agentless: false },
            null
        );
        const hosts = line.filter((_arg, i) => line[i - 1] === '--add-host');
        expect(hosts).toEqual(['host.docker.internal:host-gateway', 'db:127.0.0.1', 'cache:127.0.0.1']);
        expect(line).toEqual(expect.arrayContaining(['--network', 'factory-ai_default']));
        // Services off, or none declared: the driver's name alone.
        const off = loadDriverConfig({ RUNNER_SERVICES: '0' });
        for (const [cfg, of] of [
            [off, { ...job, services }],
            [config, job],
        ] as const) {
            const plain = supervisorCreateArgs(cfg, of, { exporting: false, agentless: false }, null);
            expect(plain.filter((_arg, i) => plain[i - 1] === '--add-host')).toEqual([
                'host.docker.internal:host-gateway',
            ]);
        }
    });
});

// Issue #774: the reviewer container is the pod's reviewer sidecar's twin — the executor image
// running the review loop over the review mailbox, in the supervisor's network namespace, as its own
// uid, with the member tree read-only but for its home, and the model credentials and nothing else.
describe('the reviewer container', () => {
    const argv = reviewerCreateArgs(config, reviewing);
    const pairs = (flag: string): string[] => argv.filter((_arg, i) => argv[i - 1] === flag);

    it('runs as its own uid in the gate group, in its supervisor’s network namespace', () => {
        expect(pairs('--user')).toEqual([`${REVIEWER_UID}:${GATE_GID}`]);
        expect(pairs('--network')).toEqual([`container:${supervisorName(reviewing)}`]);
        expect(pairs('--name')).toEqual([reviewerName(reviewing)]);
        expect(reviewerName(reviewing)).toBe(`factory-reviewer-${reviewing.id}-${reviewing.leaseToken}`);
        expect(argv).toEqual(expect.arrayContaining(['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges']));
        expect(argv).toEqual(expect.arrayContaining(['--label', 'factory.role=reviewer']));
        expect(argv).toEqual(expect.arrayContaining(['--label', `factory.lease=${reviewing.leaseToken}`]));
    });

    it('runs the review loop in the executor image', () => {
        const [image, ...command] = argv.slice(argv.indexOf('--entrypoint') + 2);
        expect(argv[argv.indexOf('--entrypoint') + 1]).toBe('sh');
        expect(image).toBe(executorImage(config, reviewing.executorType));
        expect(command).toEqual(reviewLoopArgv().slice(1));
    });

    it('mounts the member tree read-only, its home read-write and the review mailbox, no other mailbox', () => {
        const mounted = mounts(argv);
        expect(mounted).toHaveLength(3);
        const tree = mounted.find((mount) => mount.includes(`target=${config.workspaceMount}/bellows/${USER}`));
        expect(tree).toContain(`volume-subpath=bellows/${USER},`);
        expect(tree).toMatch(/,readonly$/);
        const home = mounted.find((mount) => mount.endsWith(`target=${REVIEWER_HOME}`));
        expect(home).toContain(`volume-subpath=bellows/${USER}/${REVIEWER_TREE_DIR},`);
        expect(home).not.toMatch(/readonly/);
        const review = mounted.find((mount) => mount.includes(volumeOf('review')));
        expect(review).toBeDefined();
        expect(review).not.toMatch(/readonly/);
        for (const box of ['in', 'out', 'export', 'supervisor', 'gate'] as const) {
            expect(mounted.some((mount) => mount.includes(volumeOf(box)))).toBe(false);
        }
    });

    // The model credentials ride as the agent's do — each passEnv name read from the driver's own
    // environment — and nothing else: no claim env file, no attempt or publish token, no helper.
    it('carries its home and the model credential names, never a value, a token or an env file', () => {
        expect(pairs('-e')).toEqual([`HOME=${REVIEWER_HOME}`, ...config.passEnv]);
        expect(argv).not.toContain('--env-file');
        expect(argv.join(' ')).not.toMatch(/tok-|CRED_HELPER|BELLOWS_CONTROL|SUPERVISOR_|GITHUB_TOKEN/);
    });
});

describe('the agent container', () => {
    const argv = dockerArgs(config, job, SESSION, { envFile: '/tmp/env-file' });

    it('mounts `in` read-only and `out`, and nothing of the supervisor’s own or the exporter’s', () => {
        const mounted = mounts(argv);
        expect(mounted.find((mount) => mount.includes(volumeOf('in')))).toMatch(/,readonly$/);
        const out = mounted.find((mount) => mount.includes(volumeOf('out')));
        expect(out).toBeDefined();
        expect(out).not.toMatch(/readonly/);
        expect(mounted.some((mount) => mount.includes(volumeOf('export')))).toBe(false);
        expect(mounted.some((mount) => mount.includes(volumeOf('supervisor')))).toBe(false);
    });

    // Issue #814: the agent's own owner-only directories inside the two mailboxes it mounts.
    it('is told two mailbox paths and no control credential', () => {
        expect(argv).toEqual(
            expect.arrayContaining(['FACTORY_CTL_IN=/factory/in/agent', 'FACTORY_CTL_OUT=/factory/out/agent'])
        );
        expect(argv).toContain('FACTORY_CTL_GO=/factory/in/agent/go');
        for (const name of SUPERVISOR_CREDENTIAL_NAMES) expect(argv.join(' ')).not.toContain(name);
        expect(argv.join(' ')).not.toContain('tok-supervisor');
    });
});

// The kubernetes pod keeps the supervisor's pair in the attempt Secret beside the claim env: a
// member variable under the same name would reach the agent through the same Secret key.
describe('the claim env and the supervisor’s credential names', () => {
    it('drops a member variable named like the supervisor’s control pair', () => {
        const env = claimEnv({
            ...job,
            env: { SUPERVISOR_CONTROL_TOKEN: 'evil', SUPERVISOR_CONTROL_URL: 'x', KEEP: '1' },
        });
        expect({ ...env }).toEqual({ KEEP: '1' });
        for (const name of SUPERVISOR_CREDENTIAL_NAMES) expect(RESERVED_ENV_NAMES).toContain(name);
    });
});

describe('the exporter container', () => {
    it('mounts the member’s subtree and only the mailbox it shares with the supervisor', () => {
        const mounted = mounts(exporterCreateArgs(config, job, START, '/tmp/export.env'));
        expect(mounted).toHaveLength(2);
        expect(mounted.some((mount) => mount.includes('volume-subpath=bellows/'))).toBe(true);
        expect(mounted.some((mount) => mount.includes(volumeOf('export')))).toBe(true);
    });
});

describe('creating and starting the group', () => {
    const recorder = (refuse: (argv: string[]) => boolean = () => false) => {
        const calls: string[][] = [];
        const written: { file: string; body: string; mode: number }[] = [];
        const removed: string[] = [];
        const files: RunnerFiles = {
            writeFile: (async (file: string, body: string, options: { mode: number }) => {
                written.push({ file, body, mode: options.mode });
            }) as never,
            rm: (async (file: string) => {
                removed.push(file);
            }) as never,
        };
        const execDocker = async (argv: string[]) => {
            calls.push(argv);
            if (refuse(argv)) throw new Error('daemon said no');
            return { stdout: '' };
        };
        return { calls, written, removed, deps: { config, execDocker, files } };
    };

    it('creates the labelled mailbox volumes, then the supervisor, then the exporter', async () => {
        const { calls, deps } = recorder();
        await createGroup(deps, job, SESSION, { startedAt: START });
        // Without a reviewer the review mailbox has no volume (issue #774).
        expect(ctlVolumeArgs(job)).toHaveLength(Object.keys(MAILBOXES).length - 1);
        expect(calls.slice(0, ctlVolumeArgs(job).length)).toEqual(ctlVolumeArgs(job));
        expect(calls.some((argv) => argv.includes(ctlVolumeName(job, MAILBOXES.review)))).toBe(false);
        const created = calls.filter((argv) => argv[0] === 'create').map((argv) => argv[argv.indexOf('--name') + 1]);
        expect(created).toEqual([supervisorName(job), exporterName(job)]);
    });

    it('writes each container only its own control pair to a 0600 env file and removes each', async () => {
        const { written, removed, deps } = recorder();
        await createGroup(deps, job, SESSION, { startedAt: START });
        expect(written.map((w) => w.body)).toEqual([
            'SUPERVISOR_CONTROL_URL=http://driver:7000\nSUPERVISOR_CONTROL_TOKEN=tok-supervisor\n',
            // The exporter's script reads the names it always read; the value is its own export-only token.
            'BELLOWS_CONTROL_URL=http://driver:7000\nBELLOWS_CONTROL_TOKEN=tok-export\n',
        ]);
        expect(written.every((w) => w.mode === 0o600)).toBe(true);
        expect(removed).toEqual(written.map((w) => w.file));
    });

    it('creates no exporter for a run without a transcript to export, and the supervisor still', async () => {
        const { calls, deps } = recorder();
        await createGroup(deps, { ...job, executorType: 'opencode' }, null, { startedAt: START });
        const created = calls.filter((argv) => argv[0] === 'create').map((argv) => argv[argv.indexOf('--name') + 1]);
        expect(created).toEqual([supervisorName(job)]);
    });

    it('removes what it created and throws when the daemon refuses a container', async () => {
        const { calls, deps } = recorder((argv) => argv[0] === 'create' && argv.includes(exporterName(job)));
        await expect(createGroup(deps, job, SESSION, { startedAt: START })).rejects.toThrow('daemon said no');
        expect(calls).toContainEqual(['rm', '-f', supervisorName(job)]);
        for (const box of Object.values(MAILBOXES)) {
            expect(calls).toContainEqual(['volume', 'rm', '-f', ctlVolumeName(job, box)]);
        }
    });

    it('starts the supervisor and the exporter, leaving the agent to the caller', async () => {
        const { calls, deps } = recorder();
        await startGroup(deps.execDocker, job, SESSION);
        expect(calls).toEqual([
            ['start', supervisorName(job)],
            ['start', exporterName(job)],
        ]);
    });

    // Issue #773: the gate container is the group's own, after the supervisor — whose image owns the
    // mailbox mount points the volumes take their owner from — told by the supervisor's env it is there.
    it('creates and starts the gate container of a gated checkout after the supervisor, and tells the supervisor', async () => {
        const { calls, deps } = recorder();
        await createGroup(deps, gated, SESSION, { startedAt: START });
        const created = calls.filter((argv) => argv[0] === 'create').map((argv) => argv[argv.indexOf('--name') + 1]);
        expect(created).toEqual([supervisorName(gated), exporterName(gated), gateName(gated)]);
        expect(gateName(gated)).toBe(`factory-gate-${gated.id}-${gated.leaseToken}`);
        const supervisor = calls.find((argv) => argv.includes(supervisorName(gated)))!;
        expect(supervisor).toContain('SUPERVISOR_GATE=1');
        const startCalls: string[][] = [];
        const recordStart = async (argv: string[]) => {
            startCalls.push(argv);
            return { stdout: '' };
        };
        await startGroup(recordStart, gated, SESSION);
        expect(startCalls).toEqual([
            ['start', supervisorName(gated)],
            ['start', exporterName(gated)],
            ['start', gateName(gated)],
        ]);
    });

    it('creates no gate container, and tells the supervisor of none, for a checkout that declares no gates', async () => {
        const { calls, deps } = recorder();
        await createGroup(deps, job, SESSION, { startedAt: START });
        expect(calls.some((argv) => argv.includes(gateName(job)) && argv[0] === 'create')).toBe(false);
        expect(calls.find((argv) => argv.includes(supervisorName(job)))).not.toContain('SUPERVISOR_GATE=1');
    });

    it('removes the whole group, the gate container included, when the daemon refuses the gate', async () => {
        const { calls, deps } = recorder((argv) => argv[0] === 'create' && argv.includes(gateName(gated)));
        await expect(createGroup(deps, gated, SESSION, { startedAt: START })).rejects.toThrow('daemon said no');
        expect(calls).toContainEqual(['rm', '-f', gateName(gated)]);
        expect(calls).toContainEqual(['rm', '-f', supervisorName(gated)]);
    });

    // Issue #774: the reviewer joins the supervisor's namespace, so it is created after the supervisor
    // and started after it, and only a claim that lists reviewer profiles has one.
    it('creates and starts the reviewer container, with its mailbox volume, only for a claim that lists reviewer profiles', async () => {
        const { calls, deps } = recorder();
        await createGroup(deps, reviewing, SESSION, { startedAt: START });
        const created = calls.filter((argv) => argv[0] === 'create').map((argv) => argv[argv.indexOf('--name') + 1]);
        expect(created).toEqual([supervisorName(reviewing), exporterName(reviewing), reviewerName(reviewing)]);
        expect(calls.slice(0, Object.keys(MAILBOXES).length)).toEqual(ctlVolumeArgs(reviewing, { reviewing: true }));
        expect(calls.some((argv) => argv.includes(ctlVolumeName(reviewing, MAILBOXES.review)))).toBe(true);
        const supervisor = calls.find((argv) => argv.includes(supervisorName(reviewing)))!;
        expect(supervisor).toContain('SUPERVISOR_REVIEWER=1');
        const startCalls: string[][] = [];
        await startGroup(
            async (argv) => {
                startCalls.push(argv);
                return { stdout: '' };
            },
            reviewing,
            SESSION
        );
        expect(startCalls).toEqual([
            ['start', supervisorName(reviewing)],
            ['start', exporterName(reviewing)],
            ['start', reviewerName(reviewing)],
        ]);

        const plain = recorder();
        await createGroup(plain.deps, job, SESSION, { startedAt: START });
        expect(plain.calls.some((argv) => argv.includes(reviewerName(job)))).toBe(false);
        expect(plain.calls.find((argv) => argv.includes(supervisorName(job)))).not.toContain('SUPERVISOR_REVIEWER=1');
    });

    it('removes the whole group, the reviewer container included, when the daemon refuses the reviewer', async () => {
        const { calls, deps } = recorder((argv) => argv[0] === 'create' && argv.includes(reviewerName(reviewing)));
        await expect(createGroup(deps, reviewing, SESSION, { startedAt: START })).rejects.toThrow('daemon said no');
        expect(calls).toContainEqual(['rm', '-f', reviewerName(reviewing)]);
        expect(calls).toContainEqual(['rm', '-f', supervisorName(reviewing)]);
    });

    it('removeGroup removes the reviewer container with the rest', async () => {
        const { calls, deps } = recorder();
        await removeGroup(deps.execDocker, reviewing);
        expect(calls).toContainEqual(['rm', '-f', reviewerName(reviewing)]);
    });

    it('removeGroup tolerates anything already gone', async () => {
        const { deps } = recorder(() => true);
        await expect(removeGroup(deps.execDocker, job)).resolves.toBeUndefined();
    });
});

describe('waiting for the supervisor after the agent exits', () => {
    const answering = (stdout: string) => async () => ({ stdout });

    it('reads the supervisor’s exit status from `docker wait`', async () => {
        expect(await awaitSupervisor(answering('0\n'), job)).toBe(0);
        expect(await awaitSupervisor(answering('124\n'), job)).toBe(124);
    });

    it('answers null when the daemon cannot say, or the wind-down passed', async () => {
        const refusing = async () => {
            throw new Error('timed out');
        };
        expect(await awaitSupervisor(refusing, job)).toBeNull();
        expect(await awaitSupervisor(answering(''), job)).toBeNull();
    });

    it('calls a group lost unless its supervisor finalized — an exit 0, or its own deadline 124', () => {
        expect(supervisorLossOf(SUPERVISOR_EXIT.finalized, false)).toBeNull();
        expect(supervisorLossOf(SUPERVISOR_EXIT.deadline, false)).toBeNull();
        expect(supervisorLossOf(SUPERVISOR_EXIT.failed, false)).toMatch(/exit 70/);
        expect(supervisorLossOf(SUPERVISOR_EXIT.lost, false)).toBe(
            'the task supervisor lost its driver before the agent was released'
        );
        expect(supervisorLossOf(137, false)).toMatch(/before it finalized/);
        expect(supervisorLossOf(null, false)).toMatch(/did not finalize/);
        // The backstop's own timeout is a verdict, never a loss.
        expect(supervisorLossOf(null, true)).toBeNull();
    });
});

// Issue #773 D10: the docker twin of the pod's held sidecar — a refused create names the role and image it was for.
describe('a refused sidecar create', () => {
    const refusal = (stderr: string) => Object.assign(new Error('docker create failed'), { stderr });

    it('names the gate role and image a refused pull was for', () => {
        const refused = startupRefusalOf(
            refusal('Error response from daemon: pull access denied for registry.example/gate\n'),
            { role: 'gate', image: 'registry.example/gate:1' }
        );
        expect(refused).toBeInstanceOf(StartupRefused);
        expect(refused).toMatchObject({
            startupCause: 'auth',
            role: 'gate',
            message:
                'the gate image "registry.example/gate:1" was refused: Error response from daemon: pull access denied for registry.example/gate',
        });
    });

    it('names the service and its image', () => {
        expect(
            startupRefusalOf(refusal('Error response from daemon: manifest unknown'), {
                role: 'service',
                service: 'db',
                image: 'registry.example/db:17',
            })
        ).toMatchObject({
            startupCause: 'image',
            role: 'service',
            service: 'db',
            message:
                'the service "db" image "registry.example/db:17" was refused: Error response from daemon: manifest unknown',
        });
    });

    it('keeps the executor’s own refusal as the daemon said it', () => {
        expect(startupRefusalOf(refusal('Error response from daemon: manifest unknown'))).toMatchObject({
            startupCause: 'image',
            role: 'executor',
            message: 'Error response from daemon: manifest unknown',
        });
    });
});

describe('the gate container (issue #773)', () => {
    const argv = gateCreateArgs(config, gated, 'node:24');
    const literals = (line: string[]) => line.filter((_arg, i) => line[i - 1] === '-e');

    it('runs the gate loop over the gate mailbox in the declared image, the gate shell beside it', () => {
        expect(argv.slice(-(gateLoopArgv().length + 2))).toEqual([
            '--entrypoint',
            'sh',
            'node:24',
            ...gateLoopArgv().slice(1),
        ]);
        // No `-w` into the mailbox: on an image without that directory, the daemon creates it in the
        // volume as root at the gate's create — before the supervisor's start copies its image's
        // ownership in — and the uid-1000 supervisor then cannot write its own mailbox (observed in
        // test:jobs: EACCES on mkdir '/factory/gate/staging'). The loop names the mailbox absolutely.
        expect(argv).not.toContain('-w');
    });

    it('mounts the member’s own subtree and the gate mailbox, and no other mailbox', () => {
        const mounted = mounts(argv);
        expect(mounted).toHaveLength(2);
        expect(mounted.some((mount) => mount.includes(`volume-subpath=bellows/${USER}`))).toBe(true);
        expect(mounted.some((mount) => mount.includes(volumeOf('gate')))).toBe(true);
    });

    // The gate writes the shared task worktree, so it writes as the uid:gid every other writer on
    // that tree uses (1000:1000), with a HOME that uid can write (observed: root-written files left
    // a worktree the uid-1000 reclaim could never remove).
    it('runs as the runner uid:gid with the gate env’s own literals, and no claim value or credential', () => {
        expect(argv).toEqual(expect.arrayContaining(['--user', '1000:1000']));
        expect(literals(argv)).toEqual(['HOME=/tmp', 'NPM_CONFIG_UPDATE_NOTIFIER=false']);
        expect(argv).not.toContain('--env-file');
        expect(argv.join(' ')).not.toMatch(/tok-supervisor|tok-agent|tok-export|SUPERVISOR_/);
    });

    it('leaves the npm notice to a claim that names it, and points a declared cache into the repo cache', () => {
        const named = gateCreateArgs(config, { ...gated, env: { NPM_CONFIG_UPDATE_NOTIFIER: 'true' } }, 'node:24');
        expect(literals(named)).toEqual(['HOME=/tmp']);
        const cacheJob = { ...gated, repo: 'acme/widgets', gates: { ...gated.gates!, cache: ['NPM_CONFIG_CACHE'] } };
        expect(literals(gateCreateArgs(config, cacheJob, 'node:24'))).toContain(
            `NPM_CONFIG_CACHE=/workspaces/bellows/${USER}/.cache/acme/widgets/NPM_CONFIG_CACHE`
        );
    });

    // Issue #773: the gate reaches the declared services on loopback by name, and the registry a
    // setup installs from, through the namespace its group's supervisor holds.
    it('is hardened, labelled for the fence and the reaper, and joins its supervisor’s network namespace', () => {
        expect(argv).toEqual(expect.arrayContaining(['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges']));
        expect(argv).toEqual(
            expect.arrayContaining(['--label', `factory.lease=${gated.leaseToken}`, '--label', 'factory.role=gate'])
        );
        const networked = gateCreateArgs(loadDriverConfig({ RUNNER_NETWORK: 'factory-ai_default' }), gated, 'node:24');
        for (const line of [argv, networked]) {
            expect(line.filter((arg) => arg === '--network')).toHaveLength(1);
            expect(line[line.indexOf('--network') + 1]).toBe(`container:${supervisorName(gated)}`);
            expect(line).not.toContain('--add-host');
        }
    });

    // Issue #507: sized by GATE_*, each unset slot the runner's; nothing configured leaves it unthrottled.
    it('carries the gate resources before the image, and none when unconfigured', () => {
        const sized = gateCreateArgs(
            loadDriverConfig({ RUNNER_CPU_LIMIT: '4', GATE_MEMORY_LIMIT: '8Gi', GATE_MEMORY_REQUEST: '2Gi' }),
            gated,
            'node:24'
        );
        expect(sized.slice(0, sized.indexOf('node:24'))).toEqual(
            expect.arrayContaining(['--cpus', '4', '--memory', '8589934592', '--memory-reservation', '2147483648'])
        );
        expect(argv).not.toContain('--cpus');
        expect(argv).not.toContain('--memory');
    });

    it('refuses a declared image that smuggles a flag, whitespace or an expansion, before anything is created', async () => {
        for (const image of ['-v /:/host', 'node:24 alpine', 'node:$TAG']) {
            const calls: string[][] = [];
            const deps = {
                config,
                execDocker: async (line: string[]) => {
                    calls.push(line);
                    return { stdout: '' };
                },
                files: { writeFile: (async () => undefined) as never, rm: (async () => undefined) as never },
            };
            await expect(
                createGroup(deps, { ...gated, gates: { ...gated.gates!, image } }, SESSION, { startedAt: START }),
                image
            ).rejects.toThrow(/image/);
            expect(calls.filter((line) => line[0] === 'create' && line.includes(gateName(gated)))).toEqual([]);
        }
    });
});
