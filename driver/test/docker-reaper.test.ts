import { describe, expect, it } from 'vitest';
import { containerName } from '../src/docker.js';
import { networkName, serviceContainerName } from '../src/services.js';
import type { BoardJob } from '../src/board.js';
import { createDockerReaper, parseDockerCreatedAt } from '../src/docker-reaper.js';
import type { ExecDocker } from '../src/docker-runner-support.js';
import { createReaper, type OrphanGroup } from '../src/reaper.js';

/**
 * The docker reaper arm, offline: the daemon seam is the same `ExecDocker` injected function the
 * runner tests stand in for, so the test is a router over argv that records what the arm asked
 * the daemon for. No daemon, no containers.
 */

const JOB = '11111111-1111-4111-8111-111111111111';
const LEASE = '22222222-2222-4222-8222-222222222222';
const JOB2 = '44444444-4444-4444-8444-444444444444';
const LEASE2 = '33333333-3333-4333-8333-333333333333';
const NEW_LEASE = '55555555-5555-4555-8555-555555555555';

const job = { id: JOB, leaseToken: LEASE } as BoardJob;

/** One `docker ps --format '{{json .}}'` line for a service container. */
const psLine = (fields: { id: string; jobId: string; lease: string; created: string; service?: string }) =>
    JSON.stringify({
        ID: fields.id,
        Labels: `factory.job=${fields.jobId},factory.lease=${fields.lease},factory.service=${fields.service ?? 'postgres'}`,
        CreatedAt: fields.created,
        State: 'running',
        Image: 'postgres:16',
    });

const PS_ARGS = ['ps', '-a', '--filter', 'label=factory.service', '--format', '{{json .}}'];

const router = (answers: string[][]): { execDocker: ExecDocker; calls: string[][] } => {
    const calls: string[][] = [];
    return {
        calls,
        execDocker: async (args) => {
            calls.push([...args]);
            const hit = answers.find((candidate) => candidate.length > 0 && candidate[0] === args[0]);
            if (hit) {
                answers.splice(answers.indexOf(hit), 1);
                return { stdout: hit.slice(1).join('\n') };
            }
            return { stdout: '' };
        },
    };
};

const group = (overrides: Partial<OrphanGroup> = {}): OrphanGroup => ({
    jobId: JOB,
    leaseToken: LEASE,
    createdAtMs: 0,
    objects: [{ kind: 'container', name: `${JOB}-${LEASE}-svc-postgres` }],
    ...overrides,
});

describe("parseDockerCreatedAt — docker's own timestamp spelling", () => {
    it('reads "2026-09-14 10:00:00 +0000 UTC" into epoch millis', () => {
        expect(parseDockerCreatedAt('2026-09-14 10:00:00 +0000 UTC')).toBe(Date.parse('2026-09-14T10:00:00Z'));
    });

    it('honors a non-UTC offset', () => {
        expect(parseDockerCreatedAt('2026-09-14 12:30:00 +0200 CEST')).toBe(Date.parse('2026-09-14T10:30:00Z'));
    });

    it('answers 0 for anything it cannot read — eligible, never a crash', () => {
        expect(parseDockerCreatedAt('')).toBe(0);
        expect(parseDockerCreatedAt('yesterday, probably')).toBe(0);
    });
});

describe('the docker reaper arm: scan', () => {
    it('filters by the factory.service label and groups by job and lease', async () => {
        const { execDocker, calls } = router([
            [
                PS_ARGS[0]!,
                psLine({ id: 'c1', jobId: JOB, lease: LEASE, created: '2026-09-01 00:00:00 +0000 UTC' }),
                psLine({
                    id: 'c2',
                    jobId: JOB2,
                    lease: LEASE2,
                    created: '2026-09-02 00:00:00 +0000 UTC',
                    service: 'redis',
                }),
                // A runner container: job+lease but no service label — the fence's territory.
                JSON.stringify({
                    ID: 'runner',
                    Labels: `factory.job=${JOB},factory.lease=${LEASE}`,
                    CreatedAt: '2026-09-01 00:00:00 +0000 UTC',
                }),
                // Unlabelled junk.
                JSON.stringify({ ID: 'junk', Labels: '', CreatedAt: '2026-09-01 00:00:00 +0000 UTC' }),
            ],
        ]);
        const arm = createDockerReaper(execDocker);

        const groups = await arm.scan();

        // The task-group scopes (#821 D16) are listed too: the role-labelled containers and the
        // job+lease volumes, neither of which this daemon holds.
        expect(calls).toEqual([
            PS_ARGS,
            ['ps', '-a', '--filter', 'label=factory.role', '--format', '{{json .}}'],
            [
                'volume',
                'ls',
                '--filter',
                'label=factory.job',
                '--filter',
                'label=factory.lease',
                '--format',
                '{{json .}}',
            ],
        ]);
        expect(groups).toEqual([
            {
                jobId: JOB,
                leaseToken: LEASE,
                createdAtMs: Date.parse('2026-09-01T00:00:00Z'),
                objects: [{ kind: 'container', name: 'c1' }],
            },
            {
                jobId: JOB2,
                leaseToken: LEASE2,
                createdAtMs: Date.parse('2026-09-02T00:00:00Z'),
                objects: [{ kind: 'container', name: 'c2' }],
            },
        ]);
    });

    it('answers nothing when the daemon refuses the list', async () => {
        const execDocker: ExecDocker = async () => {
            throw new Error('cannot connect to the Docker daemon');
        };
        const arm = createDockerReaper(execDocker);

        await expect(arm.scan()).resolves.toEqual([]);
    });
});

describe('the docker reaper arm: a group’s gate container (issue #773)', () => {
    const OLD = '2026-09-01 00:00:00 +0000 UTC';
    const gateLine = (id: string, lease: string) =>
        JSON.stringify({
            ID: id,
            Names: `factory-gate-${JOB}-${lease}`,
            Labels: `factory.role=gate,factory.job=${JOB},factory.lease=${lease}`,
            CreatedAt: OLD,
        });

    /** A sweep over the role scope's list, the board answering `leases`; every `ps` filter is kept. */
    const sweep = async (lines: string[], leases: { id: string; leaseToken: string }[]) => {
        const removed: string[] = [];
        const filters: string[] = [];
        const execDocker: ExecDocker = async (args) => {
            if (args[0] === 'ps') {
                filters.push(args[3]!);
                return { stdout: args.includes('label=factory.role') ? lines.join('\n') : '' };
            }
            if (args[0] === 'rm') removed.push(args[2]!);
            return { stdout: '' };
        };
        const reaper = createReaper({
            board: { leases: async () => leases.map((lease) => ({ ...lease, status: 'running' as const })) },
            arm: createDockerReaper(execDocker),
            intervalMs: 0,
            graceMs: 0,
            log: () => undefined,
            now: () => Date.now(),
        });
        await reaper.sweep();
        return { removed, filters };
    };

    it('removes the gate container of a job the board no longer knows, with its group', async () => {
        const { removed } = await sweep([gateLine('orphan', LEASE)], []);
        expect(removed).toEqual(['orphan']);
    });

    it('keeps the gate container of the live lease', async () => {
        const { removed } = await sweep([gateLine('live', LEASE)], [{ id: JOB, leaseToken: LEASE }]);
        expect(removed).toEqual([]);
    });

    it('lists no gate-environment scope: a gate container lives and ends with its group', async () => {
        const { filters } = await sweep([], []);
        expect(filters).not.toContain('label=factory.gates');
    });
});

describe('the docker reaper arm: reap', () => {
    it('removes each container by id, detaches the network, and removes the derived network', async () => {
        const { execDocker, calls } = router([
            // The network inspect: one attached endpoint the teardown must disconnect first.
            ['network', 'gate-env'],
        ]);
        const arm = createDockerReaper(execDocker);

        const removed = await arm.reap(group(), 'gone');

        expect(removed).toEqual([
            `network factory-job-${JOB}-${LEASE}-services`,
            `container ${JOB}-${LEASE}-svc-postgres`,
        ]);
        expect(calls).toEqual([
            ['network', 'inspect', '--format', '{{range .Containers}}{{println .Name}}{{end}}', networkName(job)],
            ['network', 'disconnect', '-f', networkName(job), 'gate-env'],
            ['network', 'rm', networkName(job)],
            ['rm', '-f', `${JOB}-${LEASE}-svc-postgres`],
        ]);
    });

    it('attempts the network teardown before removing containers — a failed network rm leaves them retryable', async () => {
        const calls: string[][] = [];
        const failing: ExecDocker = async (args) => {
            calls.push([...args]);
            if (args[0] === 'network' && args[1] === 'rm') {
                throw new Error(
                    'Error response from daemon: error while removing network: network has active endpoints'
                );
            }
            return { stdout: '' };
        };
        const arm = createDockerReaper(failing);

        await expect(arm.reap(group(), 'gone')).rejects.toThrow('active endpoints');
        // The containers were never touched: scan lists them, so the next sweep can retry both.
        expect(calls).toEqual([
            ['network', 'inspect', '--format', '{{range .Containers}}{{println .Name}}{{end}}', networkName(job)],
            ['network', 'rm', networkName(job)],
        ]);
    });

    it('tolerates a container vanishing between the list and its removal', async () => {
        const failing: ExecDocker = async (args) => {
            if (args[0] === 'rm') {
                throw new Error('Error response from daemon: No such container: gone');
            }
            return { stdout: '' };
        };
        const arm = createDockerReaper(failing);

        // The vanished container is not this round's removal; the network teardown continues.
        expect(await arm.reap(group(), 'gone')).toEqual([`network factory-job-${JOB}-${LEASE}-services`]);
    });

    it("keeps the derived network scoped to the group's own attempt", async () => {
        const { execDocker, calls } = router([]);
        const arm = createDockerReaper(execDocker);

        await arm.reap(group({ jobId: JOB2, leaseToken: LEASE2 }), 'superseded');

        // The network name carries THIS group's lease token — never the live attempt's.
        expect(calls).toContainEqual(['network', 'rm', networkName({ id: JOB2, leaseToken: LEASE2 } as BoardJob)]);
    });

    it('names the service container the way the fleet builder does', () => {
        // The pin that keeps the reaper's idea of a name from drifting from the spawner's.
        expect(serviceContainerName(job, 'postgres')).toBe(`factory-job-${JOB}-${LEASE}-svc-postgres`);
    });
});

/*
 * Issue #821 D16: a task group whose attempt can never tear itself down — the supervisor, the
 * exporter, the agent and the four mailbox volumes a dead driver left — is the reaper's, found by
 * the role label and the job+lease volume labels. A scan that could not read every list is no
 * scan at all, a reclaim group is out of scope, and a finished runner nobody read is kept.
 */
describe('the docker reaper arm: task groups (#821 D16)', () => {
    const OLD = '2026-09-01 00:00:00 +0000 UTC';
    const OLD_VOLUME = '2026-09-01T00:00:00Z';
    const pair = (jobId: string, lease: string) => ({ id: jobId, leaseToken: lease }) as BoardJob;
    const roleLine = (fields: {
        id: string;
        name: string;
        jobId: string;
        lease: string;
        role: string;
        state: string;
        reclaim?: boolean;
    }) =>
        JSON.stringify({
            ID: fields.id,
            Names: fields.name,
            Labels: `factory.job=${fields.jobId},factory.lease=${fields.lease},factory.role=${fields.role}${fields.reclaim ? ',factory.reclaim=true' : ''}`,
            CreatedAt: OLD,
            State: fields.state,
        });
    const volumeLine = (name: string, jobId: string, lease: string, reclaim = false) =>
        JSON.stringify({
            Name: name,
            Labels: `factory.job=${jobId},factory.lease=${lease}${reclaim ? ',factory.reclaim=true' : ''}`,
        });

    /** A daemon holding role-labelled containers and job+lease volumes; `refuse` names one verb to refuse. */
    const daemon = (
        containers: string[],
        volumes: string[],
        refuse: (args: string[]) => boolean = () => false
    ): { execDocker: ExecDocker; calls: string[][] } => {
        const calls: string[][] = [];
        const execDocker: ExecDocker = async (args) => {
            calls.push([...args]);
            if (refuse(args)) throw new Error('Error response from daemon: 503');
            if (args[0] === 'ps' && args.includes('label=factory.role')) return { stdout: containers.join('\n') };
            if (args[0] === 'volume' && args[1] === 'ls') return { stdout: volumes.join('\n') };
            if (args[0] === 'volume' && args[1] === 'inspect') return { stdout: OLD_VOLUME };
            return { stdout: '' };
        };
        return { execDocker, calls };
    };
    const group = (lease = LEASE, state = 'running', reclaim = false) => {
        const named = pair(JOB, lease);
        return {
            containers: [
                roleLine({
                    id: `sup-${lease}`,
                    name: `factory-supervisor-${JOB}-${lease}`,
                    jobId: JOB,
                    lease,
                    role: 'supervisor',
                    state: 'exited',
                    reclaim,
                }),
                roleLine({
                    id: `agent-${lease}`,
                    name: containerName(named),
                    jobId: JOB,
                    lease,
                    role: 'agent',
                    state,
                    reclaim,
                }),
            ],
            volumes: [
                volumeLine(`factory-in-${JOB}-${lease}`, JOB, lease, reclaim),
                volumeLine(`factory-kill-timeout-${JOB}-${lease}`, JOB, lease, reclaim),
            ],
        };
    };

    it("groups the role-labelled containers with the attempt's volumes, the exited runner marked unread", async () => {
        const g = group(LEASE, 'exited');
        const { execDocker } = daemon(g.containers, g.volumes);

        const groups = await createDockerReaper(execDocker).scan();

        expect(groups).toEqual([
            {
                jobId: JOB,
                leaseToken: LEASE,
                createdAtMs: Date.parse('2026-09-01T00:00:00Z'),
                objects: [
                    { kind: 'container', name: `sup-${LEASE}`, runner: true },
                    { kind: 'container', name: `agent-${LEASE}`, unread: true, runner: true },
                    { kind: 'volume', name: `factory-in-${JOB}-${LEASE}` },
                    { kind: 'volume', name: `factory-kill-timeout-${JOB}-${LEASE}` },
                ],
            },
        ]);
    });

    it('keeps a still-running runner container off the unread mark', async () => {
        const g = group(LEASE, 'running');
        const { execDocker } = daemon(g.containers, g.volumes);

        const [only] = await createDockerReaper(execDocker).scan();

        expect(only?.objects.some((object) => object.unread)).toBe(false);
    });

    it.each([
        ['the service list', (args: string[]) => args[0] === 'ps' && args.includes('label=factory.service')],
        ['the role list', (args: string[]) => args[0] === 'ps' && args.includes('label=factory.role')],
        ['the volume list', (args: string[]) => args[0] === 'volume' && args[1] === 'ls'],
        ['the volume inspect', (args: string[]) => args[0] === 'volume' && args[1] === 'inspect'],
    ])('answers nothing at all when %s is refused', async (_what, refuse) => {
        const g = group();
        const { execDocker } = daemon(g.containers, g.volumes, refuse);

        await expect(createDockerReaper(execDocker).scan()).resolves.toEqual([]);
    });

    it('tolerates a volume removed between the list and its inspect, still reaping the rest', async () => {
        const g = group(LEASE, 'exited');
        const gone = `factory-in-${JOB}-${LEASE}`;
        const { execDocker } = daemon(g.containers, g.volumes);
        const racing: ExecDocker = async (args) => {
            if (args[0] === 'volume' && args[1] === 'inspect' && args.includes(gone)) {
                throw Object.assign(new Error('Command failed'), { stderr: `Error: No such volume: ${gone}` });
            }
            return execDocker(args);
        };

        const [only] = await createDockerReaper(racing).scan();

        expect(only?.objects).toEqual([
            { kind: 'container', name: `sup-${LEASE}`, runner: true },
            { kind: 'container', name: `agent-${LEASE}`, unread: true, runner: true },
            { kind: 'volume', name: `factory-kill-timeout-${JOB}-${LEASE}` },
        ]);
    });

    it('leaves a reclaim group out of scope, containers and volumes alike', async () => {
        const g = group(LEASE, 'exited', true);
        const { execDocker } = daemon(g.containers, g.volumes);

        await expect(createDockerReaper(execDocker).scan()).resolves.toEqual([]);
    });

    it('removes the containers before the volumes they mount', async () => {
        const { execDocker, calls } = daemon([], []);

        await createDockerReaper(execDocker).reap(
            {
                jobId: JOB,
                leaseToken: LEASE,
                createdAtMs: 0,
                objects: [
                    { kind: 'volume', name: `factory-in-${JOB}-${LEASE}` },
                    { kind: 'container', name: `sup-${LEASE}` },
                ],
            },
            'gone'
        );

        const removals = calls.filter((args) => args[0] === 'rm' || (args[0] === 'volume' && args[1] === 'rm'));
        expect(removals).toEqual([
            ['rm', '-f', `sup-${LEASE}`],
            ['volume', 'rm', '-f', `factory-in-${JOB}-${LEASE}`],
        ]);
    });

    it('through the reaper: a gone job is reaped, a superseded unread runner kept with its kill marks, a live lease untouched', async () => {
        const gone = group(LEASE, 'running');
        const superseded = group(LEASE2, 'exited');
        const live = group(NEW_LEASE, 'running');
        const removed: string[] = [];
        const { execDocker } = daemon(
            [...gone.containers, ...superseded.containers, ...live.containers],
            [...gone.volumes, ...superseded.volumes, ...live.volumes]
        );
        const recording: ExecDocker = async (args) => {
            if (args[0] === 'rm' || (args[0] === 'volume' && args[1] === 'rm')) removed.push(args[args.length - 1]!);
            return execDocker(args);
        };
        const sweep = async (leases: { id: string; leaseToken: string | null; status: string }[]) => {
            removed.length = 0;
            await createReaper({
                board: { leases: async () => leases as never },
                arm: createDockerReaper(recording),
                intervalMs: 0,
                graceMs: 0,
                log: () => undefined,
            }).sweep();
            return [...removed];
        };

        // The job is terminal: every group of it goes, the unread runner too.
        expect(await sweep([{ id: JOB, leaseToken: null, status: 'succeeded' }])).toEqual(
            expect.arrayContaining([`sup-${LEASE}`, `agent-${LEASE}`, `factory-kill-timeout-${JOB}-${LEASE}`])
        );
        // Live under NEW_LEASE: no task group of the job is reaped (issue #821) — the superseded
        // LEASE group is the replacement fence's to sweep, the unread LEASE2 group keeps its kill
        // marks for the claim that adopts it, and the live attempt's own group is never touched.
        expect(await sweep([{ id: JOB, leaseToken: NEW_LEASE, status: 'running' }])).toEqual([]);
    });
});

/*
 * Issue #821 review, round 4: a scan is a snapshot — a superseded attempt's runner listed running
 * can finish before the reap. Its task group is the replacement claim's fence's to adopt or sweep,
 * so the reaper takes it only once the board says the job is gone.
 */
describe('the docker reaper arm: a live job’s task group is the fence’s (#821)', () => {
    const OLD = '2026-09-01 00:00:00 +0000 UTC';
    const containers = [
        JSON.stringify({
            ID: 'agent-old',
            Names: containerName({ id: JOB, leaseToken: LEASE } as BoardJob),
            Labels: `factory.job=${JOB},factory.lease=${LEASE},factory.role=agent`,
            CreatedAt: OLD,
            State: 'running',
        }),
    ];
    const sweep = async (lease: { leaseToken: string | null; status: string }) => {
        const removed: string[] = [];
        const execDocker: ExecDocker = async (args) => {
            if (args[0] === 'ps' && args.includes('label=factory.role')) return { stdout: containers.join('\n') };
            if (args[0] === 'rm' || (args[0] === 'volume' && args[1] === 'rm')) removed.push(args[args.length - 1]!);
            return { stdout: '' };
        };
        await createReaper({
            board: { leases: async () => [{ id: JOB, ...lease }] as never },
            arm: createDockerReaper(execDocker),
            intervalMs: 0,
            graceMs: 0,
            log: () => undefined,
        }).sweep();
        return removed;
    };

    it('deletes nothing of a superseded attempt’s group while the job lives, its runner listed running', async () => {
        expect(await sweep({ leaseToken: NEW_LEASE, status: 'running' })).toEqual([]);
        expect(await sweep({ leaseToken: null, status: 'queued' })).toEqual([]);
    });

    it('reaps it once the job is terminal', async () => {
        expect(await sweep({ leaseToken: null, status: 'succeeded' })).toEqual(['agent-old']);
    });
});
