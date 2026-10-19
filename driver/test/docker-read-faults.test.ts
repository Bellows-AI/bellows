/**
 * Every read of the docker runner's destructive and verdict paths, replayed faulted (issue #869):
 * the hard kill, the service teardown, the supervised stop, an adoption, the reaper's two verdicts
 * and the dead-service probe. The engine, its skip table and the stopAgent exception are
 * `fixtures/read-faults.ts`; each scenario's world is "something there", so every read that guards
 * a delete or a verdict answers non-empty when clean.
 *
 * Today's violations are pinned `it.fails` with their exact line set, read from an unpinned run:
 * typed reads (#869 PR A and B) flip them.
 */
import type { ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import { describe, expect } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import { containerName } from '../src/docker.js';
import { supervisorName } from '../src/docker-group.js';
import { createDockerReaper } from '../src/docker-reaper.js';
import type { ExecDocker } from '../src/docker-runner-support.js';
import { createDockerRunner } from '../src/docker-runner.js';
import { createReaper } from '../src/reaper.js';
import { commandMark } from '../src/runner.js';
import { forgetDeclaredServices, recordDeclaredServices } from '../src/services.js';
import { type DockerSpecial, routedDocker } from './fixtures/docker-daemon.js';
import {
    type Alias,
    type AllowedWrite,
    type Build,
    cleanDocker,
    DOCKER_FAULTS,
    type DockerFault,
    faultCell,
    freshJob,
    guardScenario,
    pin,
    quietSteps,
    replayDocker,
} from './fixtures/read-faults.js';

/** Names `pair`'s job and lease by role; every docker name of an attempt spells the two out. */
const aliasPair = (alias: Alias, pair: BoardJob, label: string): void => {
    alias(pair.id, 'job');
    alias(pair.leaseToken, label);
};

/** A `docker logs` child that prints `stdout` and exits 0 — enough of one for the adoption's log read. */
function loggedChild(stdout: string): ChildProcess {
    const child = new EventEmitter() as ChildProcess;
    const stream = (text: string) => {
        const s = new EventEmitter() as Readable;
        if (text) process.nextTick(() => s.emit('data', Buffer.from(text)));
        return s;
    };
    child.stdout = stream(stdout);
    child.stderr = stream('');
    process.nextTick(() => child.emit('close', 0));
    return child;
}

const runnerOf = (exec: ExecDocker, spawnFn: typeof spawn = (() => loggedChild('')) as unknown as typeof spawn) =>
    createDockerRunner(loadDriverConfig({}), spawnFn, exec, { steps: quietSteps(), sleep: async () => {} });

const is = (args: readonly string[], ...words: string[]): boolean => words.every((word, i) => args[i] === word);
const has = (args: readonly string[], word: string): boolean => args.includes(word);
const ok = (stdout = '') => ({ stdout });
/** Every removal, kill and disconnect a world allows: the daemon takes them. */
const writes: DockerSpecial = (args) =>
    is(args, 'rm') ||
    is(args, 'kill') ||
    is(args, 'network', 'rm') ||
    is(args, 'network', 'disconnect') ||
    is(args, 'volume', 'rm')
        ? ok()
        : undefined;
const either =
    (...specials: DockerSpecial[]): DockerSpecial =>
    (args) => {
        for (const special of specials) {
            const answer = special(args);
            if (answer !== undefined) return answer;
        }
    };

/** The three members of an attempt's group, each a fresh container id named by its role. */
function groupOf(alias: Alias): { agent: string; supervisor: string; exporter: string; listing: string } {
    const [agent, supervisor, exporter] = [randomUUID(), randomUUID(), randomUUID()] as const;
    alias(agent, 'agent');
    alias(supervisor, 'supervisor');
    alias(exporter, 'exporter');
    return { agent, supervisor, exporter, listing: `${agent}\n${supervisor}\n${exporter}\n` };
}

/** The service teardown's reads of an attempt with no service left and nothing on its network. */
const noFleet: DockerSpecial = (args) =>
    (is(args, 'ps') && has(args, 'label=factory.service')) || is(args, 'network', 'inspect') ? ok() : undefined;

/** D-K: the hard kill of a running attempt's group of three. */
const hardKill: Build<ExecDocker> = async (tap, alias) => {
    const job = freshJob();
    aliasPair(alias, job, 'lease');
    const group = groupOf(alias);
    const { exec } = routedDocker(
        either(writes, noFleet, (args) => (is(args, 'ps', '-aq') ? ok(group.listing) : undefined))
    );
    const runner = runnerOf(tap(exec));
    return async () => {
        await runner.kill(job);
        return [];
    };
};

/**
 * D-ST: the service teardown of one service container, a gate environment still on the network.
 * The network holds what is attached to it, and refuses its removal while anything is, as the
 * daemon does (`docker-teardown.ts:141-143`).
 */
const serviceTeardown: Build<ExecDocker> = async (tap, alias) => {
    const job = freshJob();
    aliasPair(alias, job, 'lease');
    const [service, gate] = [randomUUID(), `factory-env-${randomUUID()}`];
    alias(service, 'service');
    alias(gate, 'gate-env');
    const attached = new Set([service, gate]);
    const { exec } = routedDocker((args) => {
        if (is(args, 'ps') && has(args, 'label=factory.service'))
            return ok(attached.has(service) ? `${service}\n` : '');
        if (is(args, 'rm', '-f')) attached.delete(args[2]!);
        if (is(args, 'network', 'inspect')) return ok([...attached].map((name) => `${name}\n`).join(''));
        if (is(args, 'network', 'disconnect')) attached.delete(args[4]!);
        if (is(args, 'network', 'rm') && attached.size > 0) {
            return Object.assign(new Error('docker network rm exited 1'), {
                stderr: `Error response from daemon: error while removing network: network ${args[2]} has active endpoints`,
            });
        }
        return writes(args);
    });
    const runner = runnerOf(tap(exec));
    return async () => {
        await runner.releaseServices(job);
        return [];
    };
};

/** The members the stopAgent escalation kills (see the engine's header): the group of `groupOf`. */
const STOP_ESCALATION = ['<agent>', '<supervisor>', '<exporter>'];

/** D-SA: the supervised stop of a group whose supervisor finalized (exit 0) and whose agent is gone. */
const stopAgent: Build<ExecDocker> = async (tap, alias) => {
    const job = freshJob();
    aliasPair(alias, job, 'lease');
    const group = groupOf(alias);
    const { exec } = routedDocker(
        either(writes, noFleet, (args) => {
            if (is(args, 'wait')) return ok('0\n');
            if (is(args, 'ps', '-q') && has(args, 'label=factory.role=agent')) return ok();
            if (is(args, 'ps', '-aq')) return ok(group.listing);
        })
    );
    const runner = runnerOf(tap(exec));
    return async () => {
        await runner.stopAgent(job);
        return [];
    };
};

/** D-AD: an earlier claim's runner exited and its supervisor finalized; an older attempt left a container and a mailbox. */
const adoptExited: Build<ExecDocker> = async (tap, alias) => {
    const prior = freshJob({ claimSeq: 1 });
    const adopter = { ...prior, leaseToken: randomUUID(), claimSeq: 2 };
    const older = randomUUID();
    aliasPair(alias, prior, 'prior');
    aliasPair(alias, adopter, 'lease');
    alias(older, 'older');
    const session = randomUUID();
    alias(session, 'session');
    const [read, exporter, olderRunner] = [randomUUID(), randomUUID(), randomUUID()];
    alias(read, 'runner');
    alias(exporter, 'exporter');
    alias(olderRunner, 'older-runner');
    const listing = `${containerName(prior)}\t${prior.leaseToken}\t1\t${session}\t${commandMark(prior.command)}\n`;
    const fencePs = `${read}\t${prior.leaseToken}\n${exporter}\t${prior.leaseToken}\n${olderRunner}\t${older}\n`;
    const fenceVolumes = `factory-ctl-${prior.id}-${prior.leaseToken}\t${prior.leaseToken}\nfactory-ctl-${prior.id}-${older}\t${older}\n`;
    const { exec } = routedDocker(
        either(writes, (args) => {
            if (is(args, 'wait')) return ok('0\n');
            if (is(args, 'ps')) return ok(has(args, 'status=exited') ? listing : fencePs);
            if (is(args, 'volume', 'ls')) return ok(fenceVolumes);
            if (is(args, 'network', 'ls')) return ok();
            // No kill marker recorded: the daemon's own refusal for a volume that does not exist.
            if (is(args, 'volume', 'inspect')) {
                return Object.assign(new Error('docker volume inspect exited 1'), {
                    stderr: 'Error response from daemon: get factory-kill: no such volume',
                });
            }
            if (is(args, 'inspect')) return ok('{"Status":"exited","ExitCode":0,"StartedAt":"2026-10-01T00:00:00Z"}\n');
            if (is(args, 'logs') && has(args, supervisorName(prior))) return ok('serving steps\n');
            if (is(args, 'run')) return ok();
        })
    );
    const runner = runnerOf(tap(exec), (() => loggedChild('did the work\n')) as unknown as typeof spawn);
    return async () => ((await runner.adopt(adopter)) === null ? ['no-earlier-run'] : []);
};

/** One `docker ps --format '{{json .}}'` row of `pair`, its role or service label given. */
const psRow = (pair: BoardJob, id: string, fields: { label: string; name?: string; state: string; created: string }) =>
    JSON.stringify({
        ID: id,
        Names: fields.name ?? id,
        Labels: `factory.job=${pair.id},factory.lease=${pair.leaseToken},${fields.label}`,
        CreatedAt: fields.created,
        State: fields.state,
        Image: 'postgres:17',
    });

/** A daemon holding one attempt's service container, its exited runner group and its mailbox, all created at `created`. */
function reaperDaemon(pair: BoardJob, alias: Alias, created: { ps: string; volume: string }): ExecDocker {
    const service = randomUUID();
    const [agent, supervisor] = [randomUUID(), randomUUID()];
    const mailbox = `factory-ctl-${pair.id}-${pair.leaseToken}`;
    alias(service, 'service');
    alias(agent, 'agent');
    alias(supervisor, 'supervisor');
    const role = (id: string, name: string, roleName: string) =>
        psRow(pair, id, { label: `factory.role=${roleName}`, name, state: 'exited', created: created.ps });
    const { exec } = routedDocker(
        either(writes, (args) => {
            if (is(args, 'ps') && has(args, 'label=factory.service')) {
                return ok(
                    `${psRow(pair, service, { label: 'factory.service=db', state: 'running', created: created.ps })}\n`
                );
            }
            if (is(args, 'ps') && has(args, 'label=factory.gates')) return ok();
            if (is(args, 'ps') && has(args, 'label=factory.role')) {
                return ok(
                    `${role(agent, containerName(pair), 'agent')}\n${role(supervisor, supervisorName(pair), 'supervisor')}\n`
                );
            }
            if (is(args, 'volume', 'ls')) {
                return ok(
                    `${JSON.stringify({ Name: mailbox, Labels: `factory.job=${pair.id},factory.lease=${pair.leaseToken}` })}\n`
                );
            }
            if (is(args, 'volume', 'inspect')) return ok(`${created.volume}\n`);
            if (is(args, 'network', 'inspect')) return ok();
        })
    );
    return exec;
}

const reaperOver = (exec: ExecDocker, leases: Parameters<typeof createReaper>[0]['board']['leases'], graceMs: number) =>
    createReaper({ board: { leases }, arm: createDockerReaper(exec), intervalMs: 0, graceMs, log: () => undefined });

/** D-RP1: a live job's superseded lease left a service, an unread exited runner group and a mailbox. */
const reaperSuperseded: Build<ExecDocker> = async (tap, alias) => {
    const job = freshJob();
    const old = { ...job, leaseToken: randomUUID() };
    aliasPair(alias, old, 'old');
    const exec = reaperDaemon(old, alias, { ps: '2026-09-01 00:00:00 +0000 UTC', volume: '2026-09-01T00:00:00Z' });
    const reaper = reaperOver(
        tap(exec),
        async () => [{ id: job.id, status: 'running', leaseToken: job.leaseToken }],
        0
    );
    return async () => {
        await reaper.sweep();
        return [];
    };
};

/** Docker's own `CreatedAt` spelling of `at`. */
const dockerTime = (at: Date): string => `${at.toISOString().slice(0, 19).replace('T', ' ')} +0000 UTC`;

/** D-RP2: a job gone from the board, every object of its attempt created inside the reaper's grace. */
const reaperGone: Build<ExecDocker> = async (tap, alias) => {
    const job = freshJob();
    aliasPair(alias, job, 'lease');
    const now = new Date();
    const exec = reaperDaemon(job, alias, { ps: dockerTime(now), volume: now.toISOString() });
    const reaper = reaperOver(tap(exec), async () => [], 3_600_000);
    return async () => {
        await reaper.sweep();
        return [];
    };
};

/** D-DS: the attempt's one declared service runs. */
const deadService: Build<ExecDocker> = async (tap, alias) => {
    const job = freshJob();
    aliasPair(alias, job, 'lease');
    const row = JSON.stringify({ Labels: 'factory.service=db', Image: 'postgres:17', State: 'running' });
    const { exec } = routedDocker((args) =>
        is(args, 'ps') && has(args, 'label=factory.service') ? ok(`${row}\n`) : undefined
    );
    const runner = runnerOf(tap(exec));
    recordDeclaredServices(job, [{ name: 'db', image: 'postgres:17', environment: [] }]);
    return async () => {
        try {
            return (await runner.deadServices(job)).map((service) => `dead ${service.name}`);
        } finally {
            forgetDeclaredServices(job);
        }
    };
};

const NET = 'factory-job-<job>-<lease>-services';
const GROUP_PS = 'ps -aq --filter label=factory.job=<job> --filter label=factory.lease=<lease>';
const SERVICE_PS = `${GROUP_PS} --filter label=factory.service`;
const NET_INSPECT = `network inspect --format {{range .Containers}}{{println .Name}}{{end}} ${NET}`;
const AGENT_PS =
    'ps -q --filter label=factory.job=<job> --filter label=factory.lease=<lease> --filter label=factory.role=agent';
const HTML = '<html><body>502 Bad Gateway</body></html>';

/** A scenario's pins, by fault: one line per documented violation. */
type Pins = Partial<Record<DockerFault, RegExp[]>>;
const pinsFor = (faults: readonly DockerFault[], lines: (fault: DockerFault) => string[]): Pins =>
    Object.fromEntries(faults.map((fault) => [fault, lines(fault).map(pin)]));

/**
 * The service teardown (`dockerServiceTeardown`) every kill and stop ends in: a listing that is no
 * list of ids becomes the ids it removes (`docker-teardown.ts:139`, :154).
 */
const teardownGarbage = [
    `DELETE after garbage at ${SERVICE_PS}: rm -f ${HTML}`,
    `DELETE after garbage at ${NET_INSPECT}: network disconnect -f ${NET} ${HTML}`,
];

/** One scenario: its world, the writes its clean run makes, and — for the stop — the escalation it may make. */
interface World {
    build: Build<ExecDocker>;
    writes: unknown[];
    escalation?: readonly string[];
    /** The writes a faulted run may add because the code authorizes them on its own. */
    allowed?: AllowedWrite[];
}

function scenario(name: string, { build, writes, escalation, allowed }: World, pins: Pins): void {
    describe(name, () => {
        guardScenario(() => cleanDocker(build), { writes: writes as string[] });
        const options = { ...(escalation ? { escalation } : {}), ...(allowed ? { allowed } : {}) };
        for (const fault of DOCKER_FAULTS)
            faultCell(fault, () => replayDocker(build, fault, options), pins[fault] ?? []);
    });
}

scenario(
    'the hard kill of a group of three (D-K)',
    { build: hardKill, writes: ['kill <agent>', 'kill <supervisor>', 'kill <exporter>', `network rm ${NET}`] },
    {
        // A refused group listing reads as no group (`docker-teardown.ts:186`): nothing is killed, and
        // the service teardown's own reads (:132-156) authorize the network's removal — a write of the
        // clean sequence. Garbage becomes a kill target (`docker-teardown.ts:190`).
        garbage: [`DELETE after garbage at ${GROUP_PS}: kill ${HTML}`, ...teardownGarbage].map(pin),
    }
);

scenario(
    'the service teardown of a service and an attached gate environment (D-ST)',
    {
        build: serviceTeardown,
        writes: ['rm -f <service>', `network disconnect -f ${NET} <gate-env>`, `network rm ${NET}`],
        allowed: [
            {
                write: `network disconnect -f ${NET} <service>`,
                at: [SERVICE_PS],
                faults: ['exit', 'timeout', 'no-such'],
                why:
                    'a service left by a refused listing is still attached, and the teardown detaches what a ' +
                    'successful network inspect lists (`docker-teardown.ts:145-155`)',
            },
        ],
    },
    // A refused service listing or network inspect leaves the network removal to the daemon's own
    // refusal while endpoints remain (`docker-teardown.ts:141-157`, modelled in the world). Garbage
    // becomes a removal or detach target (`docker-teardown.ts:139`, :154).
    { garbage: teardownGarbage.map(pin) }
);

scenario(
    'the supervised stop of a finalized group (D-SA)',
    { build: stopAgent, writes: [`network rm ${NET}`], escalation: STOP_ESCALATION },
    {
        // The stopAgent exception covers the escalation's kills of the real members only: a garbage
        // agent listing is a literal kill target (`docker-teardown.ts:234`).
        garbage: [`DELETE after garbage at ${AGENT_PS}: kill ${HTML}`, ...teardownGarbage].map(pin),
    }
);

/** The adoption's fence listings (`listOtherAttemptsOrThrow`), each by job label, id or name and lease. */
const fenceList = (what: string, format: string) =>
    `${what} --filter label=factory.job=<job> --format {{.${format}}}\t{{.Label "factory.lease"}}`;

scenario(
    'an adoption of an exited earlier runner (D-AD)',
    {
        build: adoptExited,
        writes: [
            // The close-time claude-code turn read, one container over the workspace.
            expect.stringMatching(/^run .* --entrypoint node claude-executor -e <script>$/),
            'rm -f <older-runner>',
            'volume rm -f factory-ctl-<job>-<older>',
        ],
    },
    {
        garbage: [
            // A listing of no runner reads as none to adopt (`docker-close-read.ts:229` → :307).
            `VERDICT after garbage at ps -a --filter label=factory.job=<job> --filter status=exited --format {{.Names}}\t{{.Label "factory.lease"}}\t{{.Label "factory.claim-seq"}}\t{{.Label "factory.session"}}\t{{.Label "factory.command"}}: no-earlier-run`,
            // A line with no lease field reads as another attempt's leftover (`docker-runner-support.ts:182-183`).
            `DELETE after garbage at ${fenceList('ps -a', 'ID')}: rm -f ${HTML}`,
            `DELETE after garbage at ${fenceList('network ls', 'Name')}: network rm ${HTML}`,
            `DELETE after garbage at ${fenceList('volume ls', 'Name')}: volume rm -f ${HTML}`,
        ].map(pin),
    }
);

scenario(
    'the reaper on a superseded lease with an unread runner (D-RP1)',
    { build: reaperSuperseded, writes: [] },
    // A role listing of no rows (`docker-reaper.ts:129`) loses the group its runner spare
    // (`reaper.ts:136`): reaped, network first.
    {
        garbage: [
            pin(
                `DELETE after garbage at ps -a --filter label=factory.role --format {{json .}}: network rm factory-job-<job>-<old>-services`
            ),
        ],
    }
);

scenario(
    'the reaper on a gone job inside its grace (D-RP2)',
    { build: reaperGone, writes: [] },
    // An unparsable creation time dates the volume to the epoch (`docker-reaper.ts:173-174`): the
    // group reads as out of its grace and is reaped.
    pinsFor(['empty', 'garbage'], (fault) => [
        `DELETE after ${fault} at volume inspect --format {{.CreatedAt}} factory-ctl-<job>-<lease>: network rm ${NET}`,
    ])
);

scenario(
    'the dead-service probe of a running service (D-DS)',
    { build: deadService, writes: [] },
    {
        // A listing of no rows reads as every declared service removed (`docker-runner.ts:352-354`).
        garbage: [
            pin(
                `VERDICT after garbage at ps -a --filter label=factory.job=<job> --filter label=factory.lease=<lease> --filter label=factory.service --format {{json .}}: dead db`
            ),
        ],
    }
);
