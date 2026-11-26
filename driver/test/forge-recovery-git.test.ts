import { execFileSync } from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import { loadDriverConfig } from '../src/config.js';
import { gateForgeScript } from '../src/container-scripts.js';
import type { GateManager } from '../src/gate-manager.js';
import { createGateServer } from '../src/gates.js';
import { credentialHelperOf } from '../src/publish/publish-base.js';
import { pushRecorded } from '../src/publish/publish-pr.js';
import { taskCheckoutScript, worktreeBranch } from '../src/publish/publish.js';
import { credentialWait, createStepBroker, stepLost } from '../src/step-control.js';
import {
    claimStepEnv,
    forgeHostOf,
    stepHostOf,
    stepRequest,
    submitStep,
    supervisedStepRunner,
} from '../src/supervised-steps.js';
import type { RunSession } from '../src/runner.js';
import { type StepResult, SUPERVISOR_ENV } from '../src/supervisor-contract.js';
import { bindingBody } from '../src/supervisor-plan.js';
import {
    bareRepo,
    hermeticGitEnv,
    mintPrivateCa,
    type GitHttpsRemote,
    startGitHttpsRemote,
} from './fixtures/private-ca.js';
import { drive, job, ok, stubBoard, stubRunner } from './fixtures/loop-stubs.js';
import { liveSupervisors, stopSupervisors, superviseTracked } from './fixtures/supervisor-tracker.js';

/*
 * A fetch and a push of a GitLab task, interrupted by the loss of its runner, a takeover or a drain, then finished by
 * the next holder (docs/connections.md, "wait, never failure"). Nothing between the git process and the claim is
 * stubbed: a REAL git and the real forge helper run under the real supervisor.cjs, behind a private-CA https remote
 * that parks the data exchange (fixtures/private-ca.ts `holdNext`); the driver side is the real step broker and gate
 * server, whose `POST /gate-token` relay is the one played piece (the board's credential route). A step holds the
 * git process in flight when the event lands; afterwards the checkout (its uncommitted work and branch) and the
 * session state on the task volume are as the run left them, the interrupted step is lost (`stepLost`) and never a
 * result with a failure, and the next holder runs it to success.
 */
process.env.SUPERVISOR_NO_MAIN = '1';
const supervisor = createRequire(import.meta.url)('../src/scripts/supervisor.cjs') as {
    supervise(env: Record<string, string>, log: (line: string) => void): Promise<number>;
};

const SPAWN_TIMEOUT_MS = 60_000;
const MEMBER_TOKEN = 'glpat_member_recovery';
const CHECKOUT_WORK = 'agent-work.txt';
const SESSION_FILE = '.factory/session/session-1.jsonl';
const config = loadDriverConfig({});

let root: string;
let remote: GitHttpsRemote;
let bare: string;
let caPem: string;
beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'forge-recovery-'));
    const ca = mintPrivateCa(join(root, 'ca'));
    caPem = ca.caPem;
    bare = bareRepo(join(root, 'origin'));
    remote = await startGitHttpsRemote(ca, bare);
}, SPAWN_TIMEOUT_MS);
afterAll(async () => {
    await remote.close();
    rmSync(root, { recursive: true, force: true });
});

const manager: GateManager = {
    acquire: async () => {},
    runGate: async () => ({ exitCode: 0, output: '' }),
    runSetup: async () => null,
    release: () => {},
    stop: async () => {},
};

/** Each test is its own task (its own thread root and so its own branch on the shared remote). */
let taskId = '';
let tasks = 0;
beforeEach(() => {
    tasks += 1;
    taskId = `00000001-1111-4111-8111-${String(tasks).padStart(12, '0')}`;
});

const jobAt = (claimSeq: number, token: string): BoardJob =>
    ({
        ...job(1),
        id: taskId,
        rootJobId: taskId,
        claimSeq,
        leaseToken: `00000000-0000-4000-8000-00000000000${claimSeq}`,
        // The same attempt's group, whichever claim holds it: a step's identity stays the same across the takeover.
        groupLease: '00000000-0000-4000-8000-000000000001',
        repo: { forge: 'gitlab', host: remote.host, path: 'group/project' },
        supervisorEnv: { [SUPERVISOR_ENV.controlUrl]: 'http://driver', [SUPERVISOR_ENV.controlToken]: token },
    }) as BoardJob;

interface Holder {
    job: BoardJob;
    token: string;
    url: string;
    steps: ReturnType<typeof createStepBroker>;
    host: ReturnType<typeof stepHostOf>;
    close(): Promise<void>;
}

/** A driver holding one claim: the real step broker and gate server, and the board's token relay played. */
async function startHolder(claimSeq: number): Promise<Holder> {
    const token = `control-${claimSeq}`;
    const steps = createStepBroker();
    const server = createGateServer({ host: '127.0.0.1', manager, steps });
    const port = await server.listen();
    server.openControl(token);
    server.attachGateToken(token, {
        token: async () => ({ kind: 'token', token: MEMBER_TOKEN, expiresAt: null }),
    });
    steps.attach(token);
    return {
        job: jobAt(claimSeq, token),
        token,
        url: `http://127.0.0.1:${port}`,
        steps,
        host: stepHostOf({ config, steps }),
        close: () => server.close(),
    };
}

const holders: Holder[] = [];
afterEach(async () => {
    await stopSupervisors();
    for (const holder of holders.splice(0)) await holder.close();
});
afterAll(() => expect(liveSupervisors()).toBe(0));

/** One task volume (the checkout and the session state live in it) and the pod's supervisor, started on it. */
function startVolume() {
    const volume = mkdtempSync(join(root, 'volume-'));
    const checkout = join(volume, 'project');
    const bindingFile = join(volume, 'binding.json');
    const logs: string[] = [];
    const startSupervisor = (holder: Holder, claimSeq: number) => {
        void superviseTracked(
            supervisor,
            {
                FACTORY_CTL_ROOT: volume,
                SUPERVISOR_TICK_MS: '10',
                SUPERVISOR_CONTROL_MS: '10',
                SUPERVISOR_AGENTLESS: '1',
                SUPERVISOR_CONTROL_URL: holder.url,
                SUPERVISOR_CONTROL_TOKEN: holder.token,
                SUPERVISOR_CLAIM_SEQ: String(claimSeq),
                SUPERVISOR_BINDING_FILE: bindingFile,
                SUPERVISOR_FORGE_CA: caPem,
                [SUPERVISOR_ENV.forgeHelper]: gateForgeScript,
            },
            (line) => logs.push(line)
        );
    };
    /** The binding of the next claim, as `rebindGroup` writes it: the running supervisor follows it to the new driver. */
    const rebind = async (holder: Holder, claimSeq: number) => {
        writeFileSync(
            bindingFile,
            bindingBody({
                claimSeq,
                url: holder.url,
                token: holder.token,
                agentToken: `agent-${claimSeq}`,
                exportToken: `export-${claimSeq}`,
                leaseToken: holder.job.leaseToken,
            })
        );
        while (!logs.some((line) => line.startsWith(`supervisor: rebound to claim ${claimSeq}`))) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    };
    return { volume, checkout, logs, startSupervisor, rebind };
}

const hermetic = (volume: string): Record<string, string> =>
    ({ ...hermeticGitEnv(volume), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com' }) as Record<string, string>;

/** The startup sync as `runSyncStep` submits it, the checkout the one substitution: the task volume is a scratch dir. */
const syncRequest = (holder: Holder, volume: string, checkout: string, id: string) =>
    stepRequest(holder.job, 'sync', {
        id,
        argv: ['node', '-e', taskCheckoutScript],
        env: {
            ...hermetic(volume),
            ...claimStepEnv(holder.job),
            BASE_BRANCH: '',
            CHECKOUT: checkout,
            REMOTE: `https://${remote.host}/group/project.git`,
            BRANCH: worktreeBranch(holder.job),
            CRED_HELPER: credentialHelperOf(holder.job),
        },
        ...forgeHostOf(holder.job),
        timeoutMs: 30_000,
    });

const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, env: hermeticGitEnv(cwd), encoding: 'utf8' }).trim();

/** A commit the remote gains outside the task: what a fetch has to bring. */
function remoteGains(name: string): string {
    const clone = mkdtempSync(join(root, 'side-'));
    git(clone, 'clone', '-q', bare, 'side');
    const side = join(clone, 'side');
    writeFileSync(join(side, `${name}.txt`), name);
    git(side, 'add', '.');
    git(side, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', name);
    git(side, 'push', '-q', 'origin', 'HEAD:main');
    return git(bare, 'rev-parse', 'main');
}

const syncOk = (result: StepResult) => {
    expect(result.exitCode).toBe(0);
    expect(result.tokenAskUnanswered).toBeUndefined();
    expect({ stdout: result.stdout, stderr: result.stderr }).toMatchObject({
        stdout: expect.stringContaining('"ok":true'),
    });
};

/** The task as an earlier claim left it: a synced checkout with uncommitted agent work, and session state. */
async function seededTask(first: Holder) {
    const task = startVolume();
    task.startSupervisor(first, first.job.claimSeq);
    remote.requireToken = MEMBER_TOKEN;
    syncOk(await submitStep(first.host, first.job, syncRequest(first, task.volume, task.checkout, 'sync-seed')));
    writeFileSync(join(task.checkout, CHECKOUT_WORK), 'uncommitted agent work\n');
    mkdirSync(join(task.volume, '.factory/session'), { recursive: true });
    writeFileSync(join(task.volume, SESSION_FILE), '{"turn":1}\n');
    return task;
}

/** What survives an interrupted git: the checkout on its branch with the agent's work, and the session state. */
function expectSurvived(task: { volume: string; checkout: string }, branch: string) {
    expect(readFileSync(join(task.checkout, CHECKOUT_WORK), 'utf8')).toBe('uncommitted agent work\n');
    expect(git(task.checkout, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch);
    expect(() => git(task.checkout, 'fsck', '--no-progress')).not.toThrow();
    expect(readFileSync(join(task.volume, SESSION_FILE), 'utf8')).toBe('{"turn":1}\n');
}

/** No token, and no sign of the board's credential, in anything the task volume holds. */
function expectNoTokenOnVolume(volume: string) {
    const walk = (dir: string): string[] =>
        readdirSync(dir).flatMap((name) => {
            const at = join(dir, name);
            if (name === 'objects' || name === 'pack') return [];
            return statSync(at).isDirectory() ? walk(at) : [readFileSync(at, 'utf8')];
        });
    for (const text of walk(volume)) expect(text).not.toContain(MEMBER_TOKEN);
}

const EVENTS = ['runner loss', 'takeover', 'drain'] as const;
type Event = (typeof EVENTS)[number];

/**
 * Lands `event` on a step already in flight at claim 1 (`inFlight`: its remote exchange is parked), and returns the
 * next holder with the pod's supervisor serving it (a fresh pod after a loss, the same one rebound otherwise).
 */
async function interrupt(
    event: Event,
    inFlight: {
        task: ReturnType<typeof startVolume>;
        first: Holder;
        submitted: Promise<unknown>;
        park: { release: () => void };
    }
): Promise<Holder> {
    const { task, first, submitted, park } = inFlight;
    const next = await startHolder(2);
    holders.push(next);
    if (event === 'runner loss') {
        // The pod is gone: its supervisor with it, and the driver's channel to it released.
        await stopSupervisors();
        first.steps.release(first.token);
        await expect(submitted).rejects.toSatisfy((error) => stepLost(error) && !credentialWait(error));
        park.release();
        task.startSupervisor(next, 2);
        return next;
    }
    if (event === 'drain') {
        // The driver hands over in order: its waiting step is released while the supervisor runs on.
        first.steps.release(first.token);
        await expect(submitted).rejects.toSatisfy((error) => stepLost(error) && !credentialWait(error));
    }
    // A takeover leaves the old driver silent (its submit is never answered); either way the next claim's driver is
    // bound to the running supervisor, and the git it held in flight is let go on.
    await task.rebind(next, 2);
    park.release();
    return next;
}

describe('a fetch interrupted by', { timeout: SPAWN_TIMEOUT_MS }, () => {
    it.each(EVENTS)('%s: the checkout and session survive and the next holder syncs to success', async (event) => {
        const first = await startHolder(1);
        holders.push(first);
        const task = await seededTask(first);
        const branch = worktreeBranch(first.job);
        const gained = remoteGains(`gained-by-${event.replace(' ', '-')}`);
        const park = remote.holdNext('git-upload-pack');
        const submitted = submitStep(first.host, first.job, syncRequest(first, task.volume, task.checkout, 'sync-1'));
        submitted.catch(() => undefined);
        await park.reached;

        const next = await interrupt(event, { task, first, submitted, park });
        expectSurvived(task, branch);

        // The same step, as the next claim's driver submits it: it ends in success, never in a verdict from the loss.
        const finished = await submitStep(next.host, next.job, syncRequest(next, task.volume, task.checkout, 'sync-1'));
        syncOk(finished);
        expect(git(task.checkout, 'rev-parse', 'refs/remotes/origin/main')).toBe(gained);
        expectSurvived(task, branch);
        expectNoTokenOnVolume(task.volume);
    });
});

/** The publication's own push, as `pushRecorded` runs it: its ledger op, stale-lease fetch and reconcile included. */
const publishPushFor = (holder: Holder, task: { checkout: string; volume: string }, sha: string) => {
    const runStep = supervisedStepRunner(holder.host, holder.job, { kind: 'publish' });
    const inCheckout = (step: Parameters<typeof runStep>[0]) =>
        runStep({
            ...step,
            args: step.entrypoint === 'git' ? ['-C', task.checkout, ...step.args] : step.args,
            inRepo: false,
            envLiterals: { ...hermetic(task.volume), ...(step.envLiterals ?? {}) },
        });
    return pushRecorded(inCheckout, inCheckout, {
        repo: 'group/project',
        branch: worktreeBranch(holder.job),
        op: `${worktreeBranch(holder.job)}@${sha}`,
        sha,
        credentialHelper: credentialHelperOf(holder.job),
    });
};

describe('a push interrupted by', { timeout: SPAWN_TIMEOUT_MS }, () => {
    it.each(EVENTS)('%s: the checkout and session survive and the next holder lands the push', async (event) => {
        const first = await startHolder(1);
        holders.push(first);
        const task = await seededTask(first);
        const branch = worktreeBranch(first.job);
        git(
            task.checkout,
            '-c',
            'user.name=t',
            '-c',
            'user.email=t@example.com',
            'commit',
            '-q',
            '--allow-empty',
            '-m',
            event
        );
        const sha = git(task.checkout, 'rev-parse', 'HEAD');
        const park = remote.holdNext('git-receive-pack');
        const pushing = publishPushFor(first, task, sha);
        pushing.catch(() => undefined);
        await park.reached;

        const next = await interrupt(event, { task, first, submitted: pushing, park });
        expectSurvived(task, branch);

        await publishPushFor(next, task, sha);
        expect(git(bare, 'rev-parse', `refs/heads/${branch}`)).toBe(sha);
        expectSurvived(task, branch);
        expectNoTokenOnVolume(task.volume);
        expect(existsSync(task.checkout)).toBe(true);
    });
});

describe('the loop over a git interrupted for real', { timeout: SPAWN_TIMEOUT_MS }, () => {
    const LANDED = {
        ok: true,
        published: true,
        branch: 'factory/x',
        prUrl: 'https://gitlab.example.com/group/project/-/merge_requests/1',
        reason: null,
        cause: null,
        repository: 'group/project',
        baseBranch: 'main',
        prNumber: 1,
    } as const;
    const LOOP_EVENTS = ['runner loss', 'drain'] as const;

    /**
     * The loop's two claims of one task over `stubBoard`, its runner's sync and publish being the real git steps above
     * (the claim's own holder runs each). Resolves with what the board recorded once the second claim ends.
     */
    async function playTask(event: (typeof LOOP_EVENTS)[number], what: 'fetch' | 'push') {
        const first = await startHolder(1);
        const second = await startHolder(2);
        holders.push(first, second);
        const task = await seededTask(first);
        const claims = [
            { ...first.job },
            { ...second.job, resumeSessionId: 'session-1', continuesInterrupted: true },
        ] as BoardJob[];
        const holderOf = (claimed: BoardJob) => (claimed.claimSeq === 1 ? first : second);
        const branch = worktreeBranch(first.job);
        let sha = '';
        if (what === 'push') {
            git(
                task.checkout,
                '-c',
                'user.name=t',
                '-c',
                'user.email=t@example.com',
                'commit',
                '-q',
                '--allow-empty',
                '-m',
                'x'
            );
            sha = git(task.checkout, 'rev-parse', 'HEAD');
        } else {
            remoteGains(`loop-${event.replace(' ', '-')}`);
        }
        const park = remote.holdNext(what === 'fetch' ? 'git-upload-pack' : 'git-receive-pack');
        const flights: Promise<unknown>[] = [];
        const sessions: (RunSession | null)[] = [];
        const runner = stubRunner(async (_claimed, session) => {
            sessions.push(session);
            return ok();
        });
        runner.syncCheckout = async (claimed) => {
            runner.synced.push(claimed);
            if (what === 'push') return { ok: true, reason: null };
            const holder = holderOf(claimed);
            const flight = submitStep(
                holder.host,
                holder.job,
                syncRequest(holder, task.volume, task.checkout, 'sync-1')
            );
            flights.push(flight);
            const result = await flight;
            return JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}');
        };
        runner.publishGit = async (claimed) => {
            if (what === 'fetch') return LANDED;
            const holder = holderOf(claimed);
            const pushing = publishPushFor(holder, task, sha);
            flights.push(pushing);
            await pushing;
            return LANDED;
        };
        const board = stubBoard(claims);
        const done = drive({ ...board, runner });
        await park.reached;
        // The event lands on the git in flight at claim 1.
        if (event === 'runner loss') await stopSupervisors();
        first.steps.release(first.token);
        await flights[0]?.catch(() => undefined);
        if (event === 'runner loss') task.startSupervisor(second, 2);
        else await task.rebind(second, 2);
        park.release();
        await done;
        return { board, runner, sessions, task, branch, sha };
    }

    it.each(LOOP_EVENTS)(
        '%s mid-fetch: no verdict from the loss, then the next claim resumes the session and succeeds',
        async (event) => {
            const { board, runner, sessions, task, branch } = await playTask(event, 'fetch');

            expect(board.board.completed.map((done) => done.status)).toEqual(['succeeded']);
            expect(runner.reclaimed).toEqual([]);
            // The session the first claim started is resumed, never replaced; the checkout is never reclaimed.
            expect(sessions.at(-1)).toEqual({ id: 'session-1', resume: true });
            expect(runner.synced.map((claimed) => claimed.claimSeq)).toEqual([1, 2]);
            expectSurvived(task, branch);
        }
    );

    it.each(LOOP_EVENTS)(
        '%s mid-push: no verdict from the loss, then the next claim lands the push and succeeds',
        async (event) => {
            const { board, runner, sessions, task, branch, sha } = await playTask(event, 'push');

            expect(board.board.completed.map((done) => done.status)).toEqual(['succeeded']);
            expect(runner.reclaimed).toEqual([]);
            // The session the first claim started is resumed, never replaced; the checkout is never reclaimed.
            expect(sessions.at(-1)).toEqual({ id: 'session-1', resume: true });
            expect(git(bare, 'rev-parse', `refs/heads/${branch}`)).toBe(sha);
            expectSurvived(task, branch);
        }
    );
});
