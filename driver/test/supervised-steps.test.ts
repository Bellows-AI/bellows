import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import { runTimeoutMs } from '../src/claim.js';
import { dockerArgs } from '../src/docker.js';
import { supervisorCreateArgs } from '../src/docker-group.js';
import { runnerJobSpec } from '../src/k8s-podspec.js';
import { reclaimGroupSpec } from '../src/k8s-group.js';
import { CREDENTIAL_HELPER, worktreeBranch, type PublishStep } from '../src/publish.js';
import { pushWithLease } from '../src/publish-stale.js';
import { createStepBroker, StepChannelClosed, StepTimedOut, type StepSink } from '../src/step-control.js';
import {
    orderFinish,
    orderGo,
    runGateStep,
    runHelperStep,
    runReclaimStep,
    runServiceGenerationStep,
    runSyncStep,
    type SupervisedGroups,
    supervisedStepMembers,
    supervisedStepRunner,
} from '../src/supervised-steps.js';
import { serviceRestartArgv } from '../src/container-scripts.js';
import {
    AGENT_CONTAINER,
    SUPERVISOR_CONTAINER,
    SUPERVISOR_CREDENTIAL_NAMES,
    SUPERVISOR_ENV,
    type StepRequest,
    type StepResult,
} from '../src/supervisor-contract.js';
import { type HelperPlan, lookupHelper } from '../src/helpers.js';

/**
 * The supervised steps (issue #771): what the sync, the probe, the publish, the helpers and the
 * reclaim ask of an attempt's supervisor, and the one rule about credentials — they ride the step,
 * and the agent container's spec never names, mounts or carries one.
 */
const USER = '44444444-4444-4444-8444-444444444444';
const SESSION = '33333333-3333-4333-8333-333333333333';
/** The board's token minted for one step (docs/connections.md). */
const MINTED_TOKEN = 'ghs_minted-for-step-0123456789';
/** A GitHub token a board still put on the claim: a reserved name, which the steps never forward. */
const CLAIM_TOKEN = 'ghs_claim-time-abcdef';
const CONTROL_TOKEN = 'supervisor-control-token-xyz';
const config = loadDriverConfig({ EXECUTOR: 'kubernetes' });

const job: BoardJob = {
    id: '11111111-1111-4111-8111-111111111111',
    command: 'fix the failing build',
    attempts: 1,
    maxAttempts: 1,
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
    rootCommand: 'fix the failing build',
    repo: 'Bellows-AI/factory',
    env: { GITHUB_TOKEN: CLAIM_TOKEN, MEMBER_VAR: 'member' },
    supervisorEnv: { [SUPERVISOR_ENV.controlUrl]: 'http://driver:8130', [SUPERVISOR_ENV.controlToken]: CONTROL_TOKEN },
} as BoardJob;
const WORKTREE = `${config.workspaceMount}/bellows/${USER}/.worktrees/${job.id}`;

const ok = (stdout = ''): StepResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });

/** A sink that records every submitted step and answers with `answer`. */
function sink(answer: (step: StepRequest, call: number) => StepResult | Error = () => ok()) {
    const submitted: StepRequest[] = [];
    const tokens: string[] = [];
    const impl: StepSink = {
        submit: async (token, step) => {
            tokens.push(token);
            submitted.push(step);
            const given = answer(step, submitted.length);
            if (given instanceof Error) throw given;
            return given;
        },
        awaitReport: () => Promise.reject(new Error('not used')),
        contacted: () => true,
        release: () => undefined,
        attach: () => undefined,
        cancel: (token, id) => cancels.push([token, id]),
    };
    const cancels: [string, string][] = [];
    return { host: { config, sink: impl }, submitted, tokens, cancels };
}

const publishStep = (over: Partial<PublishStep> = {}): PublishStep => ({
    label: 'git push',
    entrypoint: 'git',
    args: ['push'],
    env: true,
    inRepo: true,
    ...over,
});

describe('the publish steps over the supervisor', () => {
    it("hands the claim env and the board's minted token to the step that reads them, and to no other", async () => {
        const s = sink();
        const run = supervisedStepRunner(s.host, job, { kind: 'publish', githubToken: MINTED_TOKEN });

        await run(publishStep({ label: 'git push', env: true }));
        await run(publishStep({ label: 'git commit', env: false, args: ['commit'] }));

        const [push, commit] = s.submitted;
        // The minted token is the step's; a claim value under the reserved name never rides along.
        expect(push!.env).toMatchObject({ GITHUB_TOKEN: MINTED_TOKEN, MEMBER_VAR: 'member' });
        expect(JSON.stringify(s.submitted)).not.toContain(CLAIM_TOKEN);
        expect(commit!.env).toEqual({});
        // Addressed to this attempt's supervisor by its control token, run in the task worktree.
        expect(s.tokens).toEqual([CONTROL_TOKEN, CONTROL_TOKEN]);
        expect(push!.cwd).toBe(WORKTREE);
        expect(push!.argv).toEqual(['git', 'push']);
    });

    it('keeps the literal env a step names (paths and code, never credentials)', async () => {
        const s = sink();
        await supervisedStepRunner(s.host, job, { kind: 'probe' })(
            publishStep({ label: 'probe', env: false, inRepo: false, envLiterals: { REPO: WORKTREE } })
        );
        expect(s.submitted[0]).toMatchObject({ kind: 'probe', env: { REPO: WORKTREE } });
        expect(s.submitted[0]!.cwd).toBeUndefined();
    });

    it('derives a step with a remote effect from its operation, so a retried publish asks the same push', async () => {
        const first = sink();
        const second = sink();
        const op = 'fix/10@' + 'a'.repeat(40);
        await supervisedStepRunner(first.host, job, { kind: 'publish' })(publishStep({ op }));
        await supervisedStepRunner(second.host, job, { kind: 'publish' })(publishStep({ op }));
        expect(second.submitted[0]!.id).toBe(first.submitted[0]!.id);

        // A step without an operation reads the tree as it is now: it never replays an earlier answer.
        await supervisedStepRunner(first.host, job, { kind: 'probe' })(publishStep({ label: 'probe', env: false }));
        await supervisedStepRunner(second.host, job, { kind: 'probe' })(publishStep({ label: 'probe', env: false }));
        expect(second.submitted[1]!.id).not.toBe(first.submitted[1]!.id);
    });

    it('scopes a step identity to the attempt: another lease never names a live attempt’s step', async () => {
        const a = sink();
        const b = sink();
        const op = 'fix/10@' + 'b'.repeat(40);
        await supervisedStepRunner(a.host, job, { kind: 'publish' })(publishStep({ op }));
        await supervisedStepRunner(
            b.host,
            { ...job, leaseToken: '55555555-5555-4555-8555-555555555555' },
            { kind: 'publish' }
        )(publishStep({ op }));
        expect(b.submitted[0]!.id).not.toBe(a.submitted[0]!.id);
    });

    it('asks an unanswered step again under the same identity, and gives up after three asks', async () => {
        let calls = 0;
        const s = sink((_step, call) => {
            calls = call;
            return call < 3 ? new StepTimedOut('x') : ok('landed');
        });
        const result = await supervisedStepRunner(s.host, job, { kind: 'publish' })(publishStep({ op: 'fix/10@c' }));
        expect(result.stdout).toBe('landed');
        expect(calls).toBe(3);
        // Three deliveries of one call: the same effect and the same invocation, so a supervisor that
        // already ran it answers from its ledger.
        expect(new Set(s.submitted.map((step) => step.id)).size).toBe(1);
        expect(new Set(s.submitted.map((step) => step.invocation)).size).toBe(1);

        const hopeless = sink(() => new StepTimedOut('x'));
        await expect(supervisedStepRunner(hopeless.host, job, { kind: 'publish' })(publishStep())).rejects.toThrow(
            /was not answered in time/
        );
        expect(hopeless.submitted).toHaveLength(3);
    });

    it('gives every call its own invocation, a retried publish of the same operation included', async () => {
        const s = sink();
        const run = supervisedStepRunner(s.host, job, { kind: 'publish' });
        await run(publishStep({ op: 'fix/10@d' }));
        await run(publishStep({ op: 'fix/10@d' }));
        const [first, again] = s.submitted;
        expect(again!.id).toBe(first!.id);
        expect(again!.invocation).not.toBe(first!.invocation);
        expect(first!.invocation).toMatch(/^[A-Za-z0-9_.:-]{1,160}$/);
    });

    // The stale-lease recovery asks the same push again after it refreshed the remote: a deliberate
    // new call of the same effect, which a cached answer to the first call must never stand in for.
    it('runs the stale-push recovery’s second push over the step channel, under the same effect', async () => {
        const broker = createStepBroker();
        broker.open(CONTROL_TOKEN);
        const pushes: StepRequest[] = [];
        let serving = true;
        const supervisorLoop = (async () => {
            while (serving) {
                const pulled = await broker.next(CONTROL_TOKEN, 20, new AbortController().signal);
                if (!pulled || pulled === 'closed') continue;
                const [, verb] = pulled.argv;
                let answer: StepResult = ok();
                if (verb === 'push') {
                    pushes.push(pulled);
                    answer =
                        pushes.length === 1
                            ? { exitCode: 1, stdout: '', stderr: 'rejected (stale info)', timedOut: false }
                            : ok();
                }
                if (verb === 'rev-parse')
                    answer = ok(`${pulled.argv[2] === 'HEAD' ? 'a'.repeat(40) : 'b'.repeat(40)}\n`);
                if (verb === 'rev-list') answer = ok('0\n');
                broker.settle(CONTROL_TOKEN, pulled.id, pulled.invocation, answer);
            }
        })();
        const run = supervisedStepRunner({ config, sink: broker }, job, { kind: 'publish' });
        try {
            await pushWithLease(run, publishStep({ op: 'fix/10@e', args: ['push'] }), {
                branch: 'fix/10',
                credentialHelper: 'helper',
                sha: 'a'.repeat(40),
            });
        } finally {
            serving = false;
            await supervisorLoop;
        }
        expect(pushes).toHaveLength(2);
        expect(pushes[1]!.id).toBe(pushes[0]!.id);
        expect(pushes[1]!.invocation).not.toBe(pushes[0]!.invocation);
    });

    it('does not ask again once the attempt’s channel is closed', async () => {
        const s = sink(() => new StepChannelClosed('its step was answered'));
        await expect(supervisedStepRunner(s.host, job, { kind: 'publish' })(publishStep())).rejects.toThrow(
            /supervisor channel closed/
        );
        expect(s.submitted).toHaveLength(1);
    });

    it('fails a step in the tool’s own words, stderr first', async () => {
        const s = sink(() => ({
            exitCode: 1,
            stdout: 'out',
            stderr: 'remote: Permission to x denied\n',
            timedOut: false,
        }));
        await expect(supervisedStepRunner(s.host, job, { kind: 'publish' })(publishStep())).rejects.toThrow(
            /^remote: Permission to x denied\nout$/
        );
        const timedOut = sink(() => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }));
        await expect(supervisedStepRunner(timedOut.host, job, { kind: 'publish' })(publishStep())).rejects.toThrow(
            /exceeded its 600000ms deadline/
        );
    });

    it('refuses to submit anything for an attempt with no supervisor control channel', async () => {
        const s = sink();
        const { supervisorEnv: _gone, ...bare } = job;
        await expect(
            supervisedStepRunner(s.host, bare as BoardJob, { kind: 'publish' })(publishStep())
        ).rejects.toThrow(/no supervisor control channel/);
        expect(s.submitted).toEqual([]);
    });
});

describe('the sync, the reclaim and the helpers over the supervisor', () => {
    it('syncs a starting claim with fetch credentials, the credential helper code and the paths', async () => {
        const s = sink(() => ok('{"ok":true,"reason":null,"fingerprint":"fp"}\n'));
        const result = await runSyncStep(s.host, job, MINTED_TOKEN);

        expect(result).toEqual({ ok: true, reason: null, fingerprint: 'fp' });
        const [sync] = s.submitted;
        expect(sync).toMatchObject({ kind: 'sync', timeoutMs: 600_000 });
        expect(sync!.env).toMatchObject({
            GITHUB_TOKEN: MINTED_TOKEN,
            REPO: `${config.workspaceMount}/bellows/${USER}/factory`,
            WORKTREE,
            BRANCH: worktreeBranch(job),
            CRED_HELPER: CREDENTIAL_HELPER,
        });
        expect(sync!.env.RESTORE).toBeUndefined();
    });

    it('fetches plain, with neither token nor helper, when the board issued no token', async () => {
        // A public repository's fetch must stay unauthenticated, which a helper answering an empty
        // password would break; the claim's own GitHub value is a reserved name and never forwarded.
        const s = sink(() => ok('{"ok":true,"reason":null}\n'));
        await runSyncStep(s.host, job);
        const env = s.submitted[0]!.env;
        expect(env.GITHUB_TOKEN).toBeUndefined();
        expect(env.CRED_HELPER).toBeUndefined();
        expect(env.MEMBER_VAR).toBe('member');
    });

    it('restores a continued session with no credential at all: nothing that touches the remote', async () => {
        const s = sink(() => ok('{"ok":true,"reason":null}\n'));
        await runSyncStep(s.host, { ...job, resumeSessionId: SESSION, followUp: true } as BoardJob);
        const env = s.submitted[0]!.env;
        expect(env.RESTORE).toBe('1');
        expect(env.GITHUB_TOKEN).toBeUndefined();
        expect(env.MEMBER_VAR).toBeUndefined();
        expect(env.CRED_HELPER).toBeUndefined();
    });

    it('reads a sync that printed no verdict, or timed out, as a failed sync saying why', async () => {
        const silent = sink(() => ok('npm warn\n'));
        expect(await runSyncStep(silent.host, job)).toMatchObject({
            ok: false,
            reason: expect.stringContaining('answered nothing readable'),
        });
        const slow = sink(() => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }));
        expect(await runSyncStep(slow.host, job)).toMatchObject({
            ok: false,
            reason: expect.stringContaining('deadline'),
        });
    });

    it('has nothing to sync or reclaim for a job with no repository', async () => {
        const s = sink();
        const commandOnly = { ...job, repo: undefined } as unknown as BoardJob;
        expect(await runSyncStep(s.host, commandOnly)).toEqual({ ok: true, reason: null });
        expect(await runReclaimStep(s.host, commandOnly)).toEqual({ ok: true, removed: false, reason: null });
        expect(s.submitted).toEqual([]);
    });

    it('reclaims with the clone and the worktree and no credential', async () => {
        const s = sink(() => ok('{"ok":true,"removed":true,"reason":null}\n'));
        expect(await runReclaimStep(s.host, job)).toEqual({ ok: true, removed: true, reason: null });
        expect(s.submitted[0]).toMatchObject({ kind: 'reclaim', env: { WORKTREE } });
        // The caller thread's reclaim also names its review roots: a review leaves its tree there.
        expect(s.submitted[0]!.env.REVIEW_ROOTS).toBe(`${WORKTREE}.reviews`);
        expect(Object.keys(s.submitted[0]!.env).sort()).toEqual(['REPO', 'REVIEW_ROOTS', 'WORKTREE']);
    });

    it("gives a helper the claim env and the board's minted token only when it writes to GitHub", async () => {
        const descriptor = lookupHelper('merge-conflict-probe');
        expect(descriptor).toBeTruthy();
        const reading = sink(() => ok('{}'));
        await runHelperStep(reading.host, job, {
            phase: 'pre',
            helperId: 'merge-conflict-probe',
            input: {},
            githubWriting: false,
        } as never);
        expect(reading.submitted[0]!.env.GITHUB_TOKEN).toBeUndefined();
        expect(reading.submitted[0]!.env.HELPER_INPUT).toBeDefined();

        const writing = sink(() => ok('{}'));
        await runHelperStep(
            writing.host,
            job,
            { phase: 'pre', helperId: 'merge-conflict-probe', input: {}, githubWriting: true } as never,
            { token: MINTED_TOKEN }
        );
        expect(writing.submitted[0]!.env.GITHUB_TOKEN).toBe(MINTED_TOKEN);
        expect(writing.submitted[0]!.cwd).toBe(WORKTREE);
    });

    it('answers an unknown helper before anything is submitted', async () => {
        const s = sink();
        expect(await runHelperStep(s.host, job, { phase: 'pre', helperId: 'rm-rf', input: {} } as never)).toMatchObject(
            {
                ok: false,
                reason: 'unknown_helper',
            }
        );
        expect(s.submitted).toEqual([]);
    });

    it('releases the agent with what is left of the run budget, and ends the group by order', async () => {
        const s = sink();
        await orderGo(s.host, { ...job, setupMs: 120_000 } as BoardJob);
        await orderFinish(s.host, job);
        expect(s.submitted.map((step) => step.kind)).toEqual(['go', 'finish']);
        const budget = Number(s.submitted[0]!.env.BUDGET_MS);
        expect(budget).toBeGreaterThan(0);
        expect(budget).toBe(runTimeoutMs(config, job) - 120_000);
    });
});

describe('the declared gates over the supervisor (issue #773)', () => {
    const gate = { command: 'npm test', cwd: WORKTREE, env: { CI: 'true' }, timeoutMs: 600_000 };

    it('hands the gate container the command, the worktree and the env, as a step of its own', async () => {
        const s = sink(() => ok('passed'));
        expect(await runGateStep(s.host, job, gate)).toEqual(ok('passed'));
        expect(s.submitted).toEqual([
            expect.objectContaining({
                kind: 'gate',
                argv: ['npm test'],
                cwd: WORKTREE,
                env: { CI: 'true' },
                timeoutMs: 600_000,
            }),
        ]);
        expect(s.tokens).toEqual([CONTROL_TOKEN]);
    });

    it('gives every execution its own step, the same named gate run twice included', async () => {
        const s = sink();
        await runGateStep(s.host, job, gate);
        await runGateStep(s.host, job, gate);
        const [first, second] = s.submitted;
        expect(first?.id).not.toBe(second?.id);
        expect(first?.id.startsWith('gate-')).toBe(true);
        // The attempt scopes it, as every step id: another lease never names this one's.
        const other = sink();
        await runGateStep(other.host, { ...job, leaseToken: '99999999-9999-4999-8999-999999999999' }, gate);
        expect(other.submitted[0]?.id.split('-')[1]).not.toBe(first?.id.split('-')[1]);
    });

    it('cancels its step through the channel when the signal aborts, and rejects', async () => {
        const controller = new AbortController();
        let release = (): void => undefined;
        const s = sink();
        s.host.sink.submit = (_token, step, signal) =>
            new Promise((_resolve, reject) => {
                s.submitted.push(step);
                release = () => reject(new Error(`step ${step.id} was cancelled`));
                signal?.addEventListener('abort', release, { once: true });
            });
        const running = runGateStep(s.host, job, gate, controller.signal);
        controller.abort();
        await expect(running).rejects.toThrow(/cancelled/);
        expect(s.cancels).toEqual([[CONTROL_TOKEN, s.submitted[0]?.id]]);
    });

    it('submits nothing for a signal already aborted', async () => {
        const s = sink();
        await expect(runGateStep(s.host, job, gate, AbortSignal.abort())).rejects.toThrow(/cancelled/);
        expect(s.submitted).toEqual([]);
    });
});

describe('the supervised-step members both executors share', () => {
    const NOOP: HelperPlan = { phase: 'pre', helperId: 'noop', input: {}, githubWriting: false };

    /** An executor's groups stood in: whether the attempt has one, and every group it was asked to create. */
    function groupsOver(s: ReturnType<typeof sink>, opts: { has?: boolean; refuse?: Error } = {}) {
        const created: BoardJob[] = [];
        let has = opts.has ?? false;
        const groups: SupervisedGroups = {
            host: s.host,
            hasGroup: () => has,
            createGroup: async (attempt) => {
                created.push(attempt);
                if (opts.refuse) throw opts.refuse;
                has = true;
            },
            errorDetail: (e) => `in the executor's words: ${(e as Error).message}`,
        };
        return { members: supervisedStepMembers(groups), created };
    }

    it('creates a supervisor-only group once, and only for an attempt that has none', async () => {
        const s = sink(() => ok('{}'));
        const fresh = groupsOver(s);
        await fresh.members.probeTree(job);
        await fresh.members.snapshotTree(job, 'review-1');
        expect(fresh.created).toEqual([{ ...job, agent: false }]);

        const synced = groupsOver(s, { has: true });
        await synced.members.probeTree(job);
        expect(synced.created).toEqual([]);
        expect(s.submitted.map((step) => step.kind)).toEqual(['probe', 'snapshot', 'probe']);
    });

    it('creates nothing and submits nothing for an unknown helper id', async () => {
        const s = sink();
        const { members, created } = groupsOver(s);
        expect(await members.runHelper(job, { ...NOOP, helperId: 'rm-rf' })).toMatchObject({
            ok: false,
            reason: 'unknown_helper',
        });
        expect(created).toEqual([]);
        expect(s.submitted).toEqual([]);
    });

    it('fails a helper whose group is refused in the executor’s words, and throws a lost supervisor', async () => {
        const refused = sink();
        const { members } = groupsOver(refused, { refuse: new Error('the group was refused') });
        expect(await members.runHelper(job, NOOP)).toEqual({
            ok: false,
            reason: 'runner_error',
            message: "in the executor's words: the group was refused",
        });
        expect(refused.submitted).toEqual([]);

        const lost = groupsOver(
            sink(() => new StepChannelClosed('the helper')),
            { has: true }
        );
        await expect(lost.members.runHelper(job, NOOP)).rejects.toBeInstanceOf(StepChannelClosed);
    });

    it('throws a refused group from the publish, the probe and the snapshot, submitting nothing', async () => {
        const refusal = new Error('the group was refused');
        const s = sink();
        const { members } = groupsOver(s, { refuse: refusal });
        await expect(members.publishGit(job)).rejects.toBe(refusal);
        await expect(members.probeTree(job)).rejects.toBe(refusal);
        await expect(members.snapshotTree(job, 'review-1')).rejects.toBe(refusal);
        expect(s.submitted).toEqual([]);
    });
});

describe('the services’ generations over the supervisor (issue #773 D9)', () => {
    it('reads or bumps the generations as a `restart` step of its own, a fresh one every call', async () => {
        const s = sink();
        expect(await runServiceGenerationStep(s.host, job, 'acked', ['db', 'cache'])).toEqual(ok());
        await runServiceGenerationStep(s.host, job, 'bump', ['db', 'cache']);
        const [read, bump] = s.submitted;
        expect(read).toMatchObject({ kind: 'restart', argv: serviceRestartArgv('acked', ['db', 'cache']), env: {} });
        expect(bump).toMatchObject({ kind: 'restart', argv: serviceRestartArgv('bump', ['db', 'cache']) });
        expect(read?.id).not.toBe(bump?.id);
        // A few files: well inside the broker's grace, never holding a step behind it for long.
        expect(read?.timeoutMs).toBeLessThanOrEqual(30_000);
        expect(s.tokens).toEqual([CONTROL_TOKEN, CONTROL_TOKEN]);
    });
});

/** Everything a container of the group is handed, as one string: its env, args and the Secret keys it names. */
const holds = (container: unknown): string => JSON.stringify(container);

describe('the agent environment holds no publish token', () => {
    const group = runnerJobSpec(config, job, { id: SESSION, resume: false });
    const containers = group.spec.template.spec.containers;
    const agent = containers.find((c) => c.name === AGENT_CONTAINER)!;
    const supervisor = containers.find((c) => c.name === SUPERVISOR_CONTAINER)!;

    it('names the publish token nowhere in the pod spec: the token exists only as a step env', async () => {
        // The token the board mints for a step never reaches a spec builder; the only way it leaves
        // the driver is the step it rides, addressed to the supervisor. A claim value under the
        // reserved name reaches neither.
        expect(JSON.stringify(group)).not.toContain(MINTED_TOKEN);
        expect(JSON.stringify(group)).not.toContain(CLAIM_TOKEN);
        const s = sink();
        await supervisedStepRunner(s.host, job, { kind: 'publish', githubToken: MINTED_TOKEN })(publishStep());
        expect(JSON.stringify(s.submitted)).toContain(MINTED_TOKEN);
        expect(holds(agent)).not.toContain(MINTED_TOKEN);
    });

    it('gives the agent container neither the supervisor’s credential nor a route to the step channel', () => {
        const env = JSON.stringify(agent.env);
        for (const name of SUPERVISOR_CREDENTIAL_NAMES) expect(env).not.toContain(name);
        expect(env).not.toContain(CONTROL_TOKEN);
        expect(env).not.toContain('http://driver:8130');
        // What the agent finds its supervisor through is three mailbox paths: no URL, no token.
        expect(
            agent.env
                .filter((e) => e.name.startsWith('FACTORY_CTL_'))
                .map((e) => e.name)
                .sort()
        ).toEqual(['FACTORY_CTL_GO', 'FACTORY_CTL_IN', 'FACTORY_CTL_OUT']);
    });

    it('delivers no claim env to the supervisor container: a step carries its own', () => {
        const names = supervisor.env.map((e) => e.name);
        expect(names).not.toContain('GITHUB_TOKEN');
        expect(names).not.toContain('MEMBER_VAR');
        expect(holds(supervisor)).not.toContain(CLAIM_TOKEN);
        // It mounts the member's workspace subtree — the steps work on the task worktree — and the mailboxes.
        expect(supervisor.volumeMounts.some((m) => m.name === 'workspaces' && m.subPath === `bellows/${USER}`)).toBe(
            true
        );
    });

    it('holds the same line on docker: the agent container’s argv names no step credential', () => {
        const args = dockerArgs(config, job, { id: SESSION, resume: false }, { envFile: '/tmp/agent.env' }).join(' ');
        expect(args).not.toContain(MINTED_TOKEN);
        expect(args).not.toContain(CONTROL_TOKEN);
        for (const name of SUPERVISOR_CREDENTIAL_NAMES) expect(args).not.toContain(name);
        expect(args).toContain('FACTORY_CTL_GO=');
        // The supervisor mounts the workspace there too, and carries the control pair by env file, never argv.
        const supervisorArgs = supervisorCreateArgs(
            config,
            job,
            { exporting: false, agentless: false },
            '/tmp/env'
        ).join(' ');
        expect(supervisorArgs).toContain(`bellows/${USER}`);
        expect(supervisorArgs).not.toContain(CONTROL_TOKEN);
        expect(supervisorArgs).not.toContain(CLAIM_TOKEN);
    });

    it('specs an agentless attempt’s group, and a reclaim’s, with no agent container at all', () => {
        const agentless = runnerJobSpec(config, { ...job, agent: false } as BoardJob, null);
        expect(agentless.spec.template.spec.containers.map((c) => c.name)).toEqual([SUPERVISOR_CONTAINER]);
        const reclaim = reclaimGroupSpec(config, job, job.leaseToken);
        expect(reclaim.spec.template.spec.containers.map((c) => c.name)).toEqual([SUPERVISOR_CONTAINER]);
        expect(reclaim.metadata.name).not.toBe(group.metadata.name);
        expect(holds(reclaim)).not.toContain(CLAIM_TOKEN);
    });
});
