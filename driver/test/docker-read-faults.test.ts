/**
 * Every read of the docker runner's destructive and verdict paths, replayed faulted (issue #869):
 * the hard kill, the service teardown, the supervised stop, an adoption, the reaper's two verdicts
 * and the dead-service probe. The engine, its skip table and the stopAgent exception are
 * `fixtures/read-faults.ts`; each scenario's world is "something there", so every read that guards
 * a delete or a verdict answers non-empty when clean.
 *
 * Every path reads typed (#869): a cell that holds is a plain test, and nothing is pinned.
 */
import type { ChildProcess, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import { describe, expect } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import { containerName } from '../src/docker.js';
import { supervisorName } from '../src/docker-mailbox.js';
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
    is(args, 'rm') || is(args, 'kill') || is(args, 'volume', 'rm') ? ok() : undefined;
const either =
    (...specials: DockerSpecial[]): DockerSpecial =>
    (args) => {
        for (const special of specials) {
            const answer = special(args);
            if (answer !== undefined) return answer;
        }
    };

/** A container id as the daemon prints it: 64 lowercase hex characters. */
const containerId = (): string => randomBytes(32).toString('hex');

/** The three members of an attempt's group, each a fresh container id named by its role. */
function groupOf(alias: Alias): { agent: string; supervisor: string; exporter: string; listing: string } {
    const [agent, supervisor, exporter] = [containerId(), containerId(), containerId()] as const;
    alias(agent, 'agent');
    alias(supervisor, 'supervisor');
    alias(exporter, 'exporter');
    return { agent, supervisor, exporter, listing: `${agent}\n${supervisor}\n${exporter}\n` };
}

/** The service teardown's read of an attempt with no service container left. */
const noFleet: DockerSpecial = (args) => (is(args, 'ps') && has(args, 'label=factory.service') ? ok() : undefined);

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
 * D-ST: the service teardown of one service container. A service shares its group supervisor's
 * network namespace (issue #773), so no network of its own is listed, detached or removed.
 */
const serviceTeardown: Build<ExecDocker> = async (tap, alias) => {
    const job = freshJob();
    aliasPair(alias, job, 'lease');
    const service = containerId();
    alias(service, 'service');
    const { exec } = routedDocker(
        either(writes, (args) =>
            is(args, 'ps') && has(args, 'label=factory.service') ? ok(`${service}\n`) : undefined
        )
    );
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
    const [read, exporter, olderRunner] = [containerId(), containerId(), containerId()];
    alias(read, 'runner');
    alias(exporter, 'exporter');
    alias(olderRunner, 'older-runner');
    const listing = `${containerName(prior)}\t${prior.leaseToken}\t1\t${session}\t${commandMark(prior.command)}\n`;
    const fencePs = `${read}\t${prior.leaseToken}\n${exporter}\t${prior.leaseToken}\n${olderRunner}\t${older}\n`;
    const fenceVolumes = `factory-ctl-${prior.id}-${prior.leaseToken}\t${prior.leaseToken}\nfactory-ctl-${prior.id}-${older}\t${older}\n`;
    const { exec } = routedDocker(
        either(writes, (args) => {
            if (is(args, 'wait')) return ok('0\n');
            // The adoption's one listing of the job's runners (#829), then the fence's.
            if (is(args, 'ps'))
                return ok(
                    args[args.indexOf('--format') + 1]?.startsWith('{{.Names}}')
                        ? `${listing.trimEnd()}\texited\n`
                        : fencePs
                );
            if (is(args, 'volume', 'ls')) return ok(fenceVolumes);
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
    const service = containerId();
    const [agent, supervisor] = [containerId(), containerId()];
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
        })
    );
    return exec;
}

const reaperOver = (exec: ExecDocker, leases: Parameters<typeof createReaper>[0]['board']['leases'], graceMs: number) =>
    createReaper({
        board: { leases, reclaimHolds: async () => [] },
        arm: createDockerReaper(exec),
        intervalMs: 0,
        graceMs,
        log: () => undefined,
    });

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

/** A scenario's pins, by fault: one line per documented violation. */
type Pins = Partial<Record<DockerFault, RegExp[]>>;

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
    { build: hardKill, writes: ['kill <agent>', 'kill <supervisor>', 'kill <exporter>'] },
    {}
);

scenario('the service teardown of a service (D-ST)', { build: serviceTeardown, writes: ['rm -f <service>'] }, {});

scenario(
    'the supervised stop of a finalized group (D-SA)',
    { build: stopAgent, writes: [], escalation: STOP_ESCALATION },
    {}
);

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
    {}
);

scenario('the reaper on a superseded lease with an unread runner (D-RP1)', { build: reaperSuperseded, writes: [] }, {});

scenario('the reaper on a gone job inside its grace (D-RP2)', { build: reaperGone, writes: [] }, {});

scenario('the dead-service probe of a running service (D-DS)', { build: deadService, writes: [] }, {});
