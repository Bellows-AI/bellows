import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { containerName } from '../src/docker.js';
import { serviceContainerName } from '../src/services.js';
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

/** A container id as `docker ps` prints it: 12 lowercase hex characters. */
const hexId = (seed: string): string => createHash('sha256').update(seed).digest('hex').slice(0, 12);

/** One `docker ps --format '{{json .}}'` line for a service container. */
const psLine = (fields: { id: string; jobId: string; lease: string; created: string; service?: string }) =>
    JSON.stringify({
        ID: fields.id,
        Names: 'factory-svc',
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

    it("reads Go's numeric zone names, which tzdata prints when a zone has no letter abbreviation", () => {
        expect(parseDockerCreatedAt('2026-09-14 10:00:00 -0300 -03')).toBe(Date.parse('2026-09-14T13:00:00Z'));
        expect(parseDockerCreatedAt('2026-09-14 10:00:00 +0400 +04')).toBe(Date.parse('2026-09-14T06:00:00Z'));
    });

    it('answers null for anything it cannot read — never the epoch, which would end a grace window (#869)', () => {
        expect(parseDockerCreatedAt('')).toBeNull();
        expect(parseDockerCreatedAt('yesterday, probably')).toBeNull();
    });
});

describe('parseDockerCreatedAt — the calendar must be real (#869)', () => {
    it.each([
        '2026-02-31 10:00:00 +0000 UTC',
        '2026-09-14 25:00:00 +0000 UTC',
        '2026-09-14 10:61:00 +0000 UTC',
        '2026-13-01 10:00:00 +0000 UTC',
        '2026-09-14 10:00:00 +2575 UTC',
        '0',
    ])('answers null for %s', (raw) => {
        expect(parseDockerCreatedAt(raw)).toBeNull();
    });
});

describe('the docker reaper arm: scan', () => {
    it('filters by the factory.service label and groups by job and lease', async () => {
        const { execDocker, calls } = router([
            [
                PS_ARGS[0]!,
                psLine({ id: hexId('c1'), jobId: JOB, lease: LEASE, created: '2026-09-01 00:00:00 +0000 UTC' }),
                psLine({
                    id: hexId('c2'),
                    jobId: JOB2,
                    lease: LEASE2,
                    created: '2026-09-02 00:00:00 +0000 UTC',
                    service: 'redis',
                }),
                // A runner container: job+lease but no service label — the fence's territory.
                JSON.stringify({
                    ID: hexId('runner'),
                    Names: 'factory-runner',
                    Labels: `factory.job=${JOB},factory.lease=${LEASE}`,
                    CreatedAt: '2026-09-01 00:00:00 +0000 UTC',
                }),
                // Unlabelled junk.
                JSON.stringify({
                    ID: hexId('junk'),
                    Names: 'junk',
                    Labels: '',
                    CreatedAt: '2026-09-01 00:00:00 +0000 UTC',
                }),
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
                objects: [{ kind: 'container', name: hexId('c1') }],
            },
            {
                jobId: JOB2,
                leaseToken: LEASE2,
                createdAtMs: Date.parse('2026-09-02T00:00:00Z'),
                objects: [{ kind: 'container', name: hexId('c2') }],
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
            State: 'running',
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
        const { removed } = await sweep([gateLine(hexId('orphan'), LEASE)], []);
        expect(removed).toEqual([hexId('orphan')]);
    });

    it('keeps the gate container of the live lease', async () => {
        const { removed } = await sweep([gateLine(hexId('live'), LEASE)], [{ id: JOB, leaseToken: LEASE }]);
        expect(removed).toEqual([]);
    });

    it('lists no gate-environment scope: a gate container lives and ends with its group', async () => {
        const { filters } = await sweep([], []);
        expect(filters).not.toContain('label=factory.gates');
    });
});

describe('the docker reaper arm: reap', () => {
    // Issue #773: a group shares its supervisor's network namespace, so no network is an attempt's.
    it('removes each container by id, and no network', async () => {
        const { execDocker, calls } = router([]);
        const arm = createDockerReaper(execDocker);

        const removed = await arm.reap(group(), 'gone');

        expect(removed).toEqual([`container ${JOB}-${LEASE}-svc-postgres`]);
        expect(calls).toEqual([['rm', '-f', `${JOB}-${LEASE}-svc-postgres`]]);
    });

    it('tolerates a container vanishing between the list and its removal', async () => {
        const failing: ExecDocker = async (args) => {
            if (args[0] === 'rm') {
                throw new Error('Error response from daemon: No such container: gone');
            }
            return { stdout: '' };
        };
        const arm = createDockerReaper(failing);

        // The vanished container is not this round's removal.
        expect(await arm.reap(group(), 'gone')).toEqual([]);
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
 * scan at all, and a finished runner nobody read is kept.
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
    }) =>
        JSON.stringify({
            ID: fields.id,
            Names: fields.name,
            Labels: `factory.job=${fields.jobId},factory.lease=${fields.lease},factory.role=${fields.role}`,
            CreatedAt: OLD,
            State: fields.state,
        });
    const volumeLine = (name: string, jobId: string, lease: string) =>
        JSON.stringify({
            Name: name,
            Labels: `factory.job=${jobId},factory.lease=${lease}`,
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
    const group = (lease = LEASE, state = 'running') => {
        const named = pair(JOB, lease);
        return {
            containers: [
                roleLine({
                    id: hexId(`sup-${lease}`),
                    name: `factory-supervisor-${JOB}-${lease}`,
                    jobId: JOB,
                    lease,
                    role: 'supervisor',
                    state: 'exited',
                }),
                roleLine({
                    id: hexId(`agent-${lease}`),
                    name: containerName(named),
                    jobId: JOB,
                    lease,
                    role: 'agent',
                    state,
                }),
            ],
            volumes: [
                volumeLine(`factory-in-${JOB}-${lease}`, JOB, lease),
                volumeLine(`factory-kill-timeout-${JOB}-${lease}`, JOB, lease),
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
                    { kind: 'container', name: hexId(`sup-${LEASE}`), runner: true },
                    { kind: 'container', name: hexId(`agent-${LEASE}`), unread: true, runner: true },
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

    it.each(['0', '2026-02-31T00:00:00Z', '2026-09-01', '2026-09-01 00:00:00 +0000 UTC', ''])(
        'answers nothing when a volume reports the creation time %j (#869)',
        async (createdAt) => {
            const g = group();
            const { execDocker: base } = daemon(g.containers, g.volumes);
            const execDocker: ExecDocker = async (args) =>
                args[0] === 'volume' && args[1] === 'inspect' ? { stdout: createdAt } : base(args);

            await expect(createDockerReaper(execDocker).scan()).resolves.toEqual([]);
        }
    );

    it.each(['2026-09-01T00:00:00Z', '2026-09-01T02:00:00.5+02:00'])(
        'reads the RFC3339 volume creation time %s',
        async (createdAt) => {
            const g = group();
            const { execDocker: base } = daemon(g.containers, g.volumes);
            const execDocker: ExecDocker = async (args) =>
                args[0] === 'volume' && args[1] === 'inspect' ? { stdout: createdAt } : base(args);

            expect(await createDockerReaper(execDocker).scan()).not.toEqual([]);
        }
    );

    it('reaps nothing when one in-scope row has a creation time it cannot read (#869)', async () => {
        const g = group(LEASE, 'exited');
        const corrupt = roleLine({
            id: hexId('corrupt'),
            name: 'factory-exporter',
            jobId: JOB,
            lease: LEASE,
            role: 'exporter',
            state: 'running',
        }).replace(OLD, 'yesterday, probably');
        const { execDocker } = daemon([...g.containers, corrupt], g.volumes);
        const removed: string[] = [];
        const recording: ExecDocker = async (args) => {
            if (
                args[0] === 'rm' ||
                (args[0] === 'volume' && args[1] === 'rm') ||
                (args[0] === 'network' && args[1] === 'rm')
            )
                removed.push(args[args.length - 1]!);
            return execDocker(args);
        };

        await expect(createDockerReaper(recording).scan()).resolves.toEqual([]);
        await createReaper({
            board: { leases: async () => [{ id: JOB, leaseToken: null, status: 'succeeded' }] as never },
            arm: createDockerReaper(recording),
            intervalMs: 0,
            graceMs: 0,
            log: () => undefined,
        }).sweep();
        expect(removed).toEqual([]);
    });

    it.each([
        ['a row that is not JSON', '<html>502 Bad Gateway</html>'],
        ['a row with no container id', JSON.stringify({ Names: 'x', Labels: '', CreatedAt: '' })],
        ['a row whose id is no container id', JSON.stringify({ ID: 'null', Names: 'x', Labels: '' })],
        ['a row with an empty name', JSON.stringify({ ID: 'a1a1a1a1a1a1', Names: '', Labels: '', CreatedAt: '' })],
        ['a row whose name is no name', JSON.stringify({ ID: 'a1a1a1a1a1a1', Names: '<html>', Labels: '' })],
        [
            'a row whose lease label is no lease',
            JSON.stringify({
                ID: 'a1a1a1a1a1a1',
                Names: 'x',
                Labels: `factory.role=agent,factory.job=${JOB},factory.lease=corrupt`,
                State: 'exited',
                CreatedAt: '2026-09-01 00:00:00 +0000 UTC',
            }),
        ],
        [
            'a role row with no state',
            JSON.stringify({
                ID: 'a1a1a1a1a1a1',
                Names: 'x',
                Labels: `factory.role=agent,factory.job=${JOB},factory.lease=${LEASE}`,
                CreatedAt: '2026-09-01 00:00:00 +0000 UTC',
            }),
        ],
    ])('answers nothing at all for %s, in scope or not', async (_what, row) => {
        const g = group();
        const { execDocker } = daemon([...g.containers, row], g.volumes);

        await expect(createDockerReaper(execDocker).scan()).resolves.toEqual([]);
    });

    it.each([
        ['an empty creation time', ''],
        ['a creation time that is no date', 'yesterday, probably'],
    ])('answers nothing at all for a volume inspect answering %s', async (_what, answer) => {
        const g = group();
        const { execDocker } = daemon(g.containers, g.volumes);
        const garbled: ExecDocker = async (args) =>
            args[0] === 'volume' && args[1] === 'inspect' ? { stdout: answer } : execDocker(args);

        await expect(createDockerReaper(garbled).scan()).resolves.toEqual([]);
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
            { kind: 'container', name: hexId(`sup-${LEASE}`), runner: true },
            { kind: 'container', name: hexId(`agent-${LEASE}`), unread: true, runner: true },
            { kind: 'volume', name: `factory-kill-timeout-${JOB}-${LEASE}` },
        ]);
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
                    { kind: 'container', name: hexId(`sup-${LEASE}`) },
                ],
            },
            'gone'
        );

        const removals = calls.filter((args) => args[0] === 'rm' || (args[0] === 'volume' && args[1] === 'rm'));
        expect(removals).toEqual([
            ['rm', '-f', hexId(`sup-${LEASE}`)],
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
            expect.arrayContaining([
                hexId(`sup-${LEASE}`),
                hexId(`agent-${LEASE}`),
                `factory-kill-timeout-${JOB}-${LEASE}`,
            ])
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
            ID: hexId('agent-old'),
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
        expect(await sweep({ leaseToken: null, status: 'succeeded' })).toEqual([hexId('agent-old')]);
    });
});

describe('the docker reaper arm: task volumes (issue #775)', () => {
    const ROOT = '11111111-1111-4111-8111-111111111111';
    const OTHER = '44444444-4444-4444-8444-444444444444';
    const LS = ['volume', 'ls', '--filter', 'label=factory.task-root', '--format', '{{json .}}'];
    const row = (root: string, generation: number, over: Record<string, unknown> = {}) =>
        JSON.stringify({
            Name: `factory-task-${root}-${generation}`,
            Labels: `factory.task-root=${root},factory.task-generation=${generation}`,
            ...over,
        });

    /** A daemon answering by argv: the listing from `listing`, every other call recorded and answered `rm`. */
    const CREATED = '2026-01-01T00:00:00Z';
    const daemon = (
        listing: string | Error,
        rm: (name: string) => Error | null = () => null,
        created: (name: string) => string | Error = () => CREATED
    ) => {
        const calls: string[][] = [];
        const execDocker: ExecDocker = async (args) => {
            calls.push([...args]);
            if (args[0] === 'volume' && args[1] === 'inspect') {
                const at = created(args[4]!);
                if (at instanceof Error) throw at;
                return { stdout: at };
            }
            if (args.join(' ') === LS.join(' ')) {
                if (listing instanceof Error) throw listing;
                return { stdout: listing };
            }
            if (args[0] === 'volume' && args[1] === 'rm') {
                const failure = rm(args[2]!);
                if (failure) throw failure;
            }
            return { stdout: '' };
        };
        return { calls, arm: createDockerReaper(execDocker) };
    };
    const removals = (calls: string[][]) => calls.filter((c) => c[1] === 'rm').map((c) => c[2]);

    it('lists every generation by the root label and groups them by root', async () => {
        const { arm } = daemon([row(ROOT, 1), row(ROOT, 2), row(OTHER, 1)].join('\n'));
        const createdAtMs = Date.parse(CREATED);
        expect(await arm.scanVolumes!()).toEqual({
            threads: [
                {
                    root: ROOT,
                    volumes: [
                        { name: `factory-task-${ROOT}-1`, createdAtMs },
                        { name: `factory-task-${ROOT}-2`, createdAtMs },
                    ],
                },
                { root: OTHER, volumes: [{ name: `factory-task-${OTHER}-1`, createdAtMs }] },
            ],
            skipped: [],
        });
    });

    it('reads a creation time the daemon would not give as null, keeping the listing', async () => {
        const { arm } = daemon(row(ROOT, 1), undefined, () => 'not a date');
        expect((await arm.scanVolumes!())!.threads[0]!.volumes).toEqual([
            { name: `factory-task-${ROOT}-1`, createdAtMs: null },
        ]);
    });

    it.each([
        ['a root label that is no uuid', row('not-a-uuid', 1, { Labels: 'factory.task-root=not-a-uuid' })],
        ['a name that is no generation of its root', row(ROOT, 1, { Name: 'factory-task-x' })],
        ['a volume without a root label value', JSON.stringify({ Name: `factory-task-${ROOT}-1`, Labels: '' })],
    ])('skips and names one junk volume (%s) without discarding the rest of the listing', async (_name, junk) => {
        const { arm } = daemon([junk, row(OTHER, 1)].join('\n'));
        const listing = (await arm.scanVolumes!())!;
        expect(listing.threads.map((thread) => thread.root)).toEqual([OTHER]);
        expect(listing.skipped).toHaveLength(1);
    });

    it('answers an empty daemon as no threads', async () => {
        expect(await daemon('').arm.scanVolumes!()).toEqual({ threads: [], skipped: [] });
    });

    it.each([
        ['a refused list', new Error('daemon down')],
        ['a line that is no record', 'garbage'],
    ])('answers null — delete nothing — on %s', async (_name, listing) => {
        expect(await daemon(listing).arm.scanVolumes!()).toBeNull();
    });

    it('removes every generation of a thread, without force', async () => {
        const { arm, calls } = daemon('');
        const removed = await arm.reapVolumes!({
            root: ROOT,
            volumes: [{ name: `factory-task-${ROOT}-1` }, { name: `factory-task-${ROOT}-2` }],
        });
        expect(removed).toEqual([`volume factory-task-${ROOT}-1`, `volume factory-task-${ROOT}-2`]);
        expect(calls).toEqual([
            ['volume', 'rm', `factory-task-${ROOT}-1`],
            ['volume', 'rm', `factory-task-${ROOT}-2`],
        ]);
    });

    it('does not report a volume the daemon refused to remove (in use), and goes on', async () => {
        const { arm } = daemon('', (name) => (name.endsWith('-1') ? new Error('volume is in use') : null));
        const removed = await arm.reapVolumes!({
            root: ROOT,
            volumes: [{ name: `factory-task-${ROOT}-1` }, { name: `factory-task-${ROOT}-2` }],
        });
        expect(removed).toEqual([`volume factory-task-${ROOT}-2`]);
    });

    describe('swept with the board', () => {
        const FINAL = Date.parse('2026-10-01T00:00:00Z');
        const HOUR = 3_600_000;
        const factsOf = (over: Record<string, unknown> = {}) => ({
            live: false,
            lastFinalizedAt: new Date(FINAL).toISOString(),
            artifactsComplete: true,
            checkpoint: 'complete' as const,
            checkpointFinalizedAt: new Date(FINAL).toISOString(),
            ...over,
        });
        const sweep = async (
            facts: ReturnType<typeof factsOf>,
            ageH: number,
            listing: string | Error = [row(ROOT, 1), row(ROOT, 2)].join('\n')
        ) => {
            const { arm, calls } = daemon(listing);
            await createReaper({
                board: { leases: async () => [{ id: ROOT, status: 'succeeded', leaseToken: null, thread: facts }] },
                arm,
                intervalMs: 0,
                graceMs: 0,
                volumePolicy: { ttlMs: 24 * HOUR, boundMs: 168 * HOUR },
                now: () => FINAL + ageH * HOUR,
                log: () => undefined,
            }).sweep();
            return removals(calls);
        };

        it('removes all generations after the ttl, together', async () => {
            expect(await sweep(factsOf(), 25)).toEqual([`factory-task-${ROOT}-1`, `factory-task-${ROOT}-2`]);
        });

        it.each([
            ['inside the ttl', factsOf(), 23],
            ['while a job is live', factsOf({ live: true }), 500],
            ['while artifacts are pending', factsOf({ artifactsComplete: false }), 100],
            ['while the checkpoint is truncated', factsOf({ checkpoint: 'truncated' }), 100],
            ['when the last attempt never finalized', factsOf({ lastFinalizedAt: null }), 500],
        ])('keeps the volumes %s', async (_name, facts, ageH) => {
            expect(await sweep(facts, ageH)).toEqual([]);
        });

        it('removes a truncated thread only at the bound', async () => {
            expect(await sweep(factsOf({ checkpoint: 'truncated' }), 169)).toHaveLength(2);
        });

        it('removes nothing when the volume list is refused', async () => {
            expect(await sweep(factsOf(), 500, new Error('daemon down'))).toEqual([]);
        });
    });
});
